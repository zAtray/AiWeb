from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
import transformers
from peft import LoraConfig, TaskType, get_peft_model
from torch.utils.data import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    Trainer,
    TrainingArguments,
    set_seed,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a compact BF16 LoRA adapter for the Zhizhi RAG answer style."
    )
    parser.add_argument("--model-id", default="Qwen/Qwen3-4B")
    parser.add_argument("--train-file", type=Path, default=Path("training/data/train.jsonl"))
    parser.add_argument("--eval-file", type=Path, default=Path("training/data/eval.jsonl"))
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("training/output/zhizhi-qwen3-4b-lora"),
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("training/cache/huggingface"),
    )
    parser.add_argument("--max-length", type=int, default=768)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--learning-rate", type=float, default=1.0e-4)
    parser.add_argument("--gradient-accumulation", type=int, default=8)
    parser.add_argument("--lora-rank", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument("--resume-from-checkpoint", default=None)
    return parser.parse_args()


class ChatDataset(Dataset[dict[str, list[int]]]):
    def __init__(
        self,
        path: Path,
        tokenizer: Any,
        max_length: int,
    ) -> None:
        self.items: list[dict[str, list[int]]] = []
        skipped = 0
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                row = json.loads(line)
                messages = row["messages"]
                if not messages or messages[-1]["role"] != "assistant":
                    raise ValueError(f"{path}:{line_number} must end with an assistant message")

                prompt_text = tokenizer.apply_chat_template(
                    messages[:-1],
                    tokenize=False,
                    add_generation_prompt=True,
                    enable_thinking=False,
                )
                full_text = tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=False,
                    enable_thinking=False,
                )
                prompt_ids = tokenizer(
                    prompt_text,
                    add_special_tokens=False,
                )["input_ids"]
                full_ids = tokenizer(
                    full_text,
                    add_special_tokens=False,
                    truncation=True,
                    max_length=max_length,
                )["input_ids"]

                if len(prompt_ids) >= len(full_ids):
                    skipped += 1
                    continue

                labels = list(full_ids)
                labels[: len(prompt_ids)] = [-100] * len(prompt_ids)
                self.items.append(
                    {
                        "input_ids": full_ids,
                        "attention_mask": [1] * len(full_ids),
                        "labels": labels,
                    }
                )

        if not self.items:
            raise ValueError(f"No usable examples in {path}")
        print(
            json.dumps(
                {
                    "dataset": str(path),
                    "usable": len(self.items),
                    "skipped": skipped,
                    "max_tokens": max(len(item["input_ids"]) for item in self.items),
                    "mean_tokens": round(
                        sum(len(item["input_ids"]) for item in self.items) / len(self.items),
                        2,
                    ),
                },
                ensure_ascii=False,
            )
        )

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> dict[str, list[int]]:
        return self.items[index]


@dataclass
class CompletionCollator:
    pad_token_id: int
    pad_to_multiple_of: int = 8

    def __call__(self, features: list[dict[str, list[int]]]) -> dict[str, torch.Tensor]:
        longest = max(len(feature["input_ids"]) for feature in features)
        if self.pad_to_multiple_of:
            longest = (
                (longest + self.pad_to_multiple_of - 1) // self.pad_to_multiple_of
            ) * self.pad_to_multiple_of

        input_ids: list[list[int]] = []
        attention_masks: list[list[int]] = []
        labels: list[list[int]] = []
        for feature in features:
            padding = longest - len(feature["input_ids"])
            input_ids.append(feature["input_ids"] + [self.pad_token_id] * padding)
            attention_masks.append(feature["attention_mask"] + [0] * padding)
            labels.append(feature["labels"] + [-100] * padding)

        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention_masks, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable; this training configuration requires an NVIDIA GPU.")

    gpu = torch.cuda.get_device_properties(0)
    if gpu.total_memory < 11 * 1024**3:
        raise SystemExit(
            f"At least 11 GiB VRAM is required for the BF16 4B LoRA profile; "
            f"detected {gpu.total_memory / 1024**3:.2f} GiB."
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    set_seed(args.seed)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True

    tokenizer = AutoTokenizer.from_pretrained(
        args.model_id,
        cache_dir=args.cache_dir,
        use_fast=True,
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    train_dataset = ChatDataset(args.train_file, tokenizer, args.max_length)
    eval_dataset = ChatDataset(args.eval_file, tokenizer, args.max_length)

    use_bf16 = torch.cuda.is_bf16_supported()
    dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(
        json.dumps(
            {
                "model_id": args.model_id,
                "gpu": gpu.name,
                "vram_gib": round(gpu.total_memory / 1024**3, 2),
                "dtype": str(dtype),
                "transformers": transformers.__version__,
                "torch": torch.__version__,
            },
            ensure_ascii=False,
        )
    )

    model = AutoModelForCausalLM.from_pretrained(
        args.model_id,
        cache_dir=args.cache_dir,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
        device_map={"": 0},
        attn_implementation="sdpa",
    )
    model.config.use_cache = False
    model.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False}
    )
    model.enable_input_require_grads()

    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj"]
    available_suffixes = {name.rsplit(".", 1)[-1] for name, _ in model.named_modules()}
    missing = [name for name in target_modules if name not in available_suffixes]
    if missing:
        raise RuntimeError(f"LoRA target modules not found: {missing}")

    lora_config = LoraConfig(
        r=args.lora_rank,
        lora_alpha=args.lora_rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
        target_modules=target_modules,
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    training_args = TrainingArguments(
        output_dir=str(args.output_dir / "checkpoints"),
        overwrite_output_dir=False,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=args.gradient_accumulation,
        learning_rate=args.learning_rate,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        weight_decay=0.01,
        max_grad_norm=1.0,
        logging_steps=5,
        eval_strategy="steps",
        eval_steps=25,
        save_strategy="steps",
        save_steps=25,
        save_total_limit=2,
        bf16=use_bf16,
        fp16=not use_bf16,
        tf32=True,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="adamw_torch_fused",
        dataloader_num_workers=0,
        remove_unused_columns=False,
        report_to="none",
        seed=args.seed,
        data_seed=args.seed,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=CompletionCollator(tokenizer.pad_token_id),
    )

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    train_result = trainer.train(resume_from_checkpoint=args.resume_from_checkpoint)
    elapsed = time.perf_counter() - started
    eval_metrics = trainer.evaluate()

    final_dir = args.output_dir / "adapter"
    final_dir.mkdir(parents=True, exist_ok=True)
    trainer.model.save_pretrained(final_dir, safe_serialization=True)
    tokenizer.save_pretrained(final_dir)

    report = {
        "model_id": args.model_id,
        "adapter_dir": str(final_dir.resolve()),
        "train_examples": len(train_dataset),
        "eval_examples": len(eval_dataset),
        "max_length": args.max_length,
        "epochs": args.epochs,
        "elapsed_seconds": round(elapsed, 2),
        "peak_vram_gib": round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        "train_metrics": train_result.metrics,
        "eval_metrics": eval_metrics,
        "versions": {
            "python": sys.version,
            "platform": platform.platform(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
        },
    }
    (args.output_dir / "training-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
