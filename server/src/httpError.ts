/** Throwable equivalent of FastAPI's HTTPException; converted to
 * res.status(status).json({detail}) by the error handler in app.ts. */
export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly detail: string,
	) {
		super(detail);
		this.name = "HttpError";
	}
}
