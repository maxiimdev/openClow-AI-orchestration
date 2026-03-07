<script setup lang="ts">
import { useConnectionStore } from '~/stores/connection'
import { WifiOff } from 'lucide-vue-next'
const conn = useConnectionStore()
</script>

<template>
  <div v-if="conn.isStale" role="status" aria-live="polite" class="flex items-center gap-2 rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground mb-3">
    <WifiOff class="h-3.5 w-3.5 shrink-0" aria-hidden="true"/>
    <span>Live updates unavailable</span>
  </div>
</template>
