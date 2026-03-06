<script setup lang="ts">
import { useConnectionStore } from '~/stores/connection'
const conn = useConnectionStore()
</script>

<template>
  <div v-if="conn.isStale" role="status" aria-live="polite" class="flex items-center gap-1 rounded bg-warning-muted px-2 py-1 text-xs text-warning-muted-foreground">
    <span class="h-2 w-2 rounded-full bg-warning" aria-hidden="true"/>
    Live updates unavailable
  </div>
</template>
