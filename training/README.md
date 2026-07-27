# 智知本地模型微调

此目录用于把通用 Qwen3 调整为更稳定的知识库证据回答模型，目标是：

- 只根据检索片段回答，不补充资料外猜测；
- 每个事实完整标注引用；
- 资料缺失或冲突时明确拒答；
- 忽略文档正文中的提示词注入；
- 使用较短回答降低问答延迟。

真正的权重微调计划采用 `Qwen/Qwen3-4B` 的 BF16 LoRA，而不是直接训练现有 GGUF。
GGUF 是推理格式，训练需要 Hugging Face 原始权重。选择 4B 是为了让 BF16
LoRA 能在 RTX 3060 12GB 上运行，并避免 QLoRA 适配器与 Ollama 的基础量化
方式不一致。当前尚未下载 4B 原始权重，因此 LoRA 训练还未启动。

## 当前可用的 GPU 任务适配

在 LoRA 权重可用前，已经验证了现有 `qwen3:8b` 的提示词与三条少样本适配：

```powershell
node .\training\evaluate_ollama.mjs `
  --model qwen3:8b `
  --system-file .\training\system-prompt-optimized.txt `
  --few-shot-file .\training\few-shot-optimized.json `
  --num-gpu 99 `
  --keep-alive 10m `
  --limit 32 `
  --output .\training\output\few-shot-qwen3-8b-gpu-32.json `
  --quiet
```

2026-07-27 在 RTX 3060 12GB 上的结果：

- 31/32 通过，通过率 96.88%；
- 引用召回率 97.37%；
- 无答案、提示注入、冲突证据三类全部通过；
- P50 延迟 0.98 秒，P95 延迟 1.25 秒；
- 热启动生成速度中位数 60.26 token/s；
- 模型自身约占 5.27GB 显存。

`--num-gpu 99` 用于连同输出层一起放入 GPU。首次冷加载可能超过 50 秒，后续
常驻请求约 1 秒。质量结果对应“基础模型 + 显式 system + 显式少样本消息”；
不要让调用端用另一条 system 消息覆盖该配置。

## 1. 构造数据

```powershell
node .\training\build-dataset.mjs
```

训练集和评测集使用不同主题。数据生成器不直接复用数据库中的演示答案，因为
那些答案高度重复，且只覆盖单引用摘要。

## 2. 建立环境

本机可使用 Codex 的隔离 Python 3.12：

```powershell
$python = "C:\Users\Ray\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
& $python -m venv .\training\.venv
& .\training\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\training\.venv\Scripts\python.exe -m pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
& .\training\.venv\Scripts\python.exe -m pip install -r .\training\requirements-train.txt
```

## 3. 训练

```powershell
& .\training\.venv\Scripts\python.exe .\training\train_lora.py
```

默认配置为 BF16、LoRA rank 8、最大长度 768、有效批量 8、训练 1 轮。输出位于
`training/output/zhizhi-qwen3-4b-lora/`。

## 4. 转换并导入 Ollama

先取得官方 `llama.cpp` 转换脚本：

```powershell
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git .\training\tools\llama.cpp
& .\training\.venv\Scripts\python.exe -m pip install -r .\training\tools\llama.cpp\requirements.txt
.\training\export_adapter.ps1
```

启动使用 `E:\ModelServer\models` 的 Ollama 服务并确保存在 `qwen3:4b` 后：

```powershell
$env:OLLAMA_MODELS = "E:\ModelServer\models"
ollama pull qwen3:4b
Push-Location .\training
ollama create zhizhi-qwen3:4b -f .\Modelfile
Pop-Location
```

## 5. 对比评测

```powershell
node .\training\evaluate_ollama.mjs --model qwen3:4b --output .\training\output\baseline.json
node .\training\evaluate_ollama.mjs --model zhizhi-qwen3:4b --output .\training\output\tuned.json
```

只有在微调模型的评测通过率、引用召回率优于基线，同时延迟仍在可接受范围内时，
才应把项目的默认模型切换到微调版本。

参考：

- [Qwen3 官方仓库](https://github.com/QwenLM/Qwen3)
- [PyTorch Windows/CUDA 安装](https://pytorch.org/get-started/locally/)
- [Ollama 导入模型与适配器](https://docs.ollama.com/import)
- [llama.cpp LoRA 转换脚本](https://github.com/ggml-org/llama.cpp/blob/master/convert_lora_to_gguf.py)
