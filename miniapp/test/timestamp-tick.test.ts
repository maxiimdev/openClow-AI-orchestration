import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { formatRelativeTime } from '~/lib/mappers'

// Test component that uses a tick-driven timestamp display
const TickingTimestamp = defineComponent({
  props: {
    isoDate: { type: String, required: true },
  },
  setup(props) {
    const tick = ref(0)
    const display = () => {
      // Reference tick to create dependency
      void tick.value
      return formatRelativeTime(props.isoDate)
    }
    return { tick, display }
  },
  template: '<span data-testid="ts">{{ display() }}</span>',
  // Expose tick for manual increment in tests
  expose: ['tick'],
})

describe('timestamp tick-driven updates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('formatRelativeTime returns correct value at different points in time', () => {
    const base = new Date('2025-06-01T12:00:00Z').getTime()
    vi.setSystemTime(base)

    // 10 seconds ago
    const tenSecAgo = new Date(base - 10_000).toISOString()
    expect(formatRelativeTime(tenSecAgo)).toBe('10s ago')

    // Advance 50 more seconds — now it's 60s = 1m ago
    vi.setSystemTime(base + 50_000)
    expect(formatRelativeTime(tenSecAgo)).toBe('1m ago')

    // Advance to 2 hours later
    vi.setSystemTime(base + 7200_000)
    expect(formatRelativeTime(tenSecAgo)).toBe('2h ago')
  })

  it('tick increment causes re-render with updated time', async () => {
    const base = new Date('2025-06-01T12:00:00Z').getTime()
    vi.setSystemTime(base)

    const tenSecAgo = new Date(base - 10_000).toISOString()
    const wrapper = mount(TickingTimestamp, {
      props: { isoDate: tenSecAgo },
    })

    expect(wrapper.find('[data-testid="ts"]').text()).toBe('10s ago')

    // Advance time by 50s and increment tick to force re-render
    vi.setSystemTime(base + 50_000)
    wrapper.vm.tick++
    await flushPromises()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="ts"]').text()).toBe('1m ago')
  })
})
