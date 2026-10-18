<script lang="ts">
  let { status }: { status: string } = $props();
</script>

<span
  class="dot"
  class:running={status === "running"}
  class:stopped={status === "stopped"}
  title={status}
></span>

<style>
  .dot {
    display: inline-block;
    flex: none;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--accent);
  }

  .running {
    background: var(--running);
  }

  .stopped {
    background: var(--stopped);
  }
</style>
