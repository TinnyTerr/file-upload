/** Messages exchanged with the AEAD web worker. */

export type AeadRequest =
	| { type: "encrypt"; id: number; blob: Blob; key: Uint8Array }
	| { type: "decrypt"; id: number; blob: Blob; key: Uint8Array };

export type AeadResponse =
	| { type: "progress"; id: number; percent: number }
	| { type: "result"; id: number; blob: Blob }
	| { type: "error"; id: number; message: string };
