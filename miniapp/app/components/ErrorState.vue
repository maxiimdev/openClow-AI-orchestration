<script setup lang="ts">
import Button from '~/components/ui/button/Button.vue'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'

defineProps<{ message: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <Card role="alert" class="border-destructive">
    <CardContent class="flex flex-col items-center justify-center py-12 text-center">
      <div class="text-4xl mb-4 text-destructive/50" aria-hidden="true">!</div>
      <h3 class="text-lg font-medium text-destructive">Something went wrong</h3>
      <p class="mt-1 text-sm text-muted-foreground">{{ message }}</p>
      <Button class="mt-4" @click="$emit('retry')">Retry</Button>
    </CardContent>
  </Card>
</template>
