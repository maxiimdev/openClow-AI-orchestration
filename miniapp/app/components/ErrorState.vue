<script setup lang="ts">
import Button from '~/components/ui/button/Button.vue'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import { AlertCircle } from 'lucide-vue-next'

defineProps<{ message: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <Card role="alert" class="border-destructive/50">
    <CardContent class="flex flex-col items-center justify-center py-10 text-center">
      <div class="rounded-full bg-severity-critical-muted p-3 mb-4">
        <AlertCircle class="h-6 w-6 text-severity-critical-foreground" aria-hidden="true" />
      </div>
      <h3 class="text-base font-medium text-foreground">Something went wrong</h3>
      <p class="mt-1.5 text-sm text-muted-foreground max-w-[320px]">{{ message }}</p>
      <Button variant="outline" class="mt-4" @click="$emit('retry')">Retry</Button>
    </CardContent>
  </Card>
</template>
