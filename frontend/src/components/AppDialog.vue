<script setup lang="ts">
import { reactive, watch } from "vue";
import type { DialogState } from "../composables/dialog";

const props = defineProps<{ dialog: DialogState }>();
const emit = defineEmits<{
  submit: [values: Record<string, string>];
  cancel: [];
}>();
const values = reactive<Record<string, string>>({});

watch(
  () => props.dialog,
  (dialog) => {
    Object.keys(values).forEach((key) => delete values[key]);
    dialog.fields.forEach((field) => {
      values[field.key] = field.value;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="modal-backdrop dialog-backdrop" @click.self="emit('cancel')">
    <form class="app-dialog" role="dialog" aria-modal="true" @submit.prevent="emit('submit', { ...values })">
      <header>
        <div>
          <p class="eyebrow">CONFIRM ACTION</p>
          <h2>{{ dialog.title }}</h2>
        </div>
        <button type="button" aria-label="关闭对话框" @click="emit('cancel')">×</button>
      </header>
      <p v-if="dialog.message" class="dialog-message">{{ dialog.message }}</p>
      <div v-if="dialog.fields.length" class="dialog-fields">
        <label v-for="field in dialog.fields" :key="field.key">
          {{ field.label }}
          <select v-if="field.options" v-model="values[field.key]" :required="field.required">
            <option v-for="option in field.options" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <textarea
            v-else-if="field.multiline"
            v-model="values[field.key]"
            rows="4"
            :required="field.required"
          ></textarea>
          <input v-else v-model="values[field.key]" :required="field.required" />
        </label>
      </div>
      <footer>
        <button type="button" @click="emit('cancel')">取消</button>
        <button class="primary" :class="{ danger: dialog.destructive }">
          {{ dialog.confirmLabel }}
        </button>
      </footer>
    </form>
  </div>
</template>
