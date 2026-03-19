import type { OmProtocolSettings } from '../types';

/**
 * Protocol handler signature – identical to MapLibre's addProtocol handler so
 * that `omProtocol` can be passed directly.
 */
export type ProtocolHandler = (
	params: { url: string; type: string; headers?: Record<string, string> },
	abortController: AbortController,
	settings?: OmProtocolSettings
) => Promise<{ data: unknown }>;

export interface RegisteredProtocol {
	handler: ProtocolHandler;
	settings?: OmProtocolSettings;
}

export interface ProtocolAdapter {
	/**
	 * Register a protocol handler.
	 * The handler receives params and an AbortController, just like MapLibre's addProtocol.
	 *
	 * @param protocol - Protocol prefix WITHOUT the trailing "://", e.g. `"om"`.
	 * @param handler  - Protocol handler (e.g. `omProtocol`).
	 * @param settings - Optional OmProtocolSettings forwarded to every handler call.
	 */
	addProtocol: (protocol: string, handler: ProtocolHandler, settings?: OmProtocolSettings) => void;

	/**
	 * Unregister a previously registered protocol handler.
	 *
	 * @param protocol - Protocol prefix WITHOUT the trailing "://", e.g. `"om"`.
	 */
	removeProtocol: (protocol: string) => void;
}
