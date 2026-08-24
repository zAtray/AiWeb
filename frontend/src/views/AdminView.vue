<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";
import { formatDate } from "../formatters";
import type { UserRole } from "../types";

const w = requireWorkspace(inject(workspaceKey));

function handleRoleChange(item: (typeof w.users.value)[number], event: Event) {
  const select = event.target as HTMLSelectElement;
  const nextRole = select.value as UserRole;
  select.value = item.role;
  void w.changeRole(item, nextRole);
}
</script>

<template>
  <div class="page">
    <section class="admin-grid">
      <article class="panel">
        <div class="panel-title"><div><p class="eyebrow">REVIEW QUEUE</p><h3>共享文档审核</h3></div><span>{{ w.shareRequests.value.length }} 待处理</span></div>
        <div class="review-list">
          <div v-for="item in w.shareRequests.value" :key="item.id">
            <div><b>{{ item.title }}</b><small>{{ item.owner_name }} · {{ item.category }} · {{ formatDate(item.updated_at) }}</small></div>
            <button @click="w.openDocument(item)">预览</button>
            <button class="approve" :disabled="w.isPending('admin:review')" @click="w.reviewDocument(item, true)">通过</button>
            <button class="reject" :disabled="w.isPending('admin:review')" @click="w.reviewDocument(item, false)">驳回</button>
          </div>
          <p v-if="!w.shareRequests.value.length" class="empty">审核队列已清空。</p>
        </div>
      </article>
      <article class="panel">
        <div class="panel-title"><div><p class="eyebrow">USER ROLES</p><h3>用户与角色</h3></div></div>
        <div class="user-table">
          <div v-for="item in w.users.value" :key="item.id">
            <span class="avatar-small">{{ item.username.slice(0, 1) }}</span>
            <div><b>{{ item.username }}</b><small>{{ item.email || item.phone || "未填写联系方式" }} · {{ item.document_count }} 文档</small></div>
            <select
              :value="item.role"
              :disabled="w.user.value?.role !== 'system_admin' || item.id === w.user.value?.id || w.isPending('admin:role')"
              :title="item.id === w.user.value?.id ? '不能修改自己的系统管理员角色' : '修改用户角色'"
              @change="handleRoleChange(item, $event)"
            >
              <option value="user">普通用户</option>
              <option value="department_admin">部门管理员</option>
              <option value="system_admin">系统管理员</option>
            </select>
          </div>
        </div>
      </article>
    </section>
  </div>
</template>
