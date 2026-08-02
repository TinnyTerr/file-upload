export const dirKeys = {
	list: ["directories", "list"] as const,
	browse: (parentId: number | null) =>
		["directories", "browse", parentId] as const,
	links: (id: number) => ["directories", "links", id] as const,
};
