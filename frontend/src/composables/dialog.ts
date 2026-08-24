import { ref } from "vue";

export interface DialogOption {
  value: string;
  label: string;
}

export interface DialogField {
  key: string;
  label: string;
  value: string;
  required?: boolean;
  multiline?: boolean;
  options?: DialogOption[];
}

export interface DialogState {
  title: string;
  message?: string;
  confirmLabel: string;
  destructive?: boolean;
  fields: DialogField[];
}

type DialogResult = Record<string, string> | null;

export function createDialogController() {
  const dialog = ref<DialogState | null>(null);
  let resolveDialog: ((value: DialogResult) => void) | null = null;

  function open(config: Omit<DialogState, "fields"> & { fields?: DialogField[] }) {
    if (resolveDialog) resolveDialog(null);
    dialog.value = { ...config, fields: config.fields ?? [] };
    return new Promise<DialogResult>((resolve) => {
      resolveDialog = resolve;
    });
  }

  function confirm(title: string, message: string, confirmLabel = "确认") {
    return open({ title, message, confirmLabel }).then(Boolean);
  }

  function destructive(title: string, message: string, confirmLabel = "删除") {
    return open({ title, message, confirmLabel, destructive: true }).then(Boolean);
  }

  function submit(values: Record<string, string>) {
    resolveDialog?.(values);
    resolveDialog = null;
    dialog.value = null;
  }

  function cancel() {
    resolveDialog?.(null);
    resolveDialog = null;
    dialog.value = null;
  }

  return { dialog, open, confirm, destructive, submit, cancel };
}
