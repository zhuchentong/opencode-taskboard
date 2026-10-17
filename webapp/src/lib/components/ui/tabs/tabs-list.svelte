<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { ComponentProps, Snippet } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithoutChildrenOrChild<ComponentProps<typeof TabsPrimitive.List>> & {
		children: Snippet;
	} = $props();
</script>

<TabsPrimitive.List
	bind:ref
	data-slot="tabs-list"
	class={cn(
		"bg-muted text-muted-foreground inline-flex h-8 w-fit items-center justify-center rounded-lg p-[3px]",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</TabsPrimitive.List>
