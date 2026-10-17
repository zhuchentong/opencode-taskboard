<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { ComponentProps, Snippet } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithoutChildrenOrChild<ComponentProps<typeof TabsPrimitive.Content>> & {
		children: Snippet;
	} = $props();
</script>

<TabsPrimitive.Content
	bind:ref
	data-slot="tabs-content"
	class={cn("flex-1 outline-none", className)}
	{...restProps}
>
	{@render children?.()}
</TabsPrimitive.Content>
