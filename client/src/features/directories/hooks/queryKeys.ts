export const dirKeys = {
	list: ["directories", "list"] as const,
	members: (id: number) => ["directories", "members", id] as const,
	links: (id: number) => ["directories", "links", id] as const,
};
