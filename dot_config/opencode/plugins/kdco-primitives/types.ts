/**
 * Shared types for kdco registry plugins.
 *
 * @module kdco-primitives/types
 */

/**
 * OpenCode client instance type.
 *
 * Local structural type covering only the members used by kdco registry
 * plugins (app.log for warning output), so no V1 SDK types are imported.
 */
export type OpencodeClient = {
	app: {
		log(input: {
			body: { service: string; level: string; message: string }
		}): Promise<unknown>
	}
}
