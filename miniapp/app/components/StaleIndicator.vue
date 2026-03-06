<script setup lang="ts">
import { useConnectionStore } from '~/stores/connection'
const conn = useConnectionStore()
</script>

<template>
  <div v-if="conn.isStale" class="flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
    <span class="h-2 w-2 rounded-full bg-amber-400"/>
    Live updates unavailable
  </div>
</template>
