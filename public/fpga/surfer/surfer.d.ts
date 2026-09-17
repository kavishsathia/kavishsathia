/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

/**
 * Key for the [`crate::wave_data::WaveData::displayed_items`] hash map
 */
export class DisplayedItemRef {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    0: number;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * Your handle to the web app from JavaScript.
 */
export class WebHandle {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Installs a panic hook, then returns.
     */
    constructor();
    /**
     * Call this once from JavaScript to start your app.
     */
    start(canvas: HTMLCanvasElement): Promise<void>;
}

export function cxxrtl_cs_message(): Promise<string | undefined>;

export function draw_text_arrow(id: number, from_item: string, from_time: bigint, to_item: string, to_time: bigint, text: string): Promise<void>;

/**
 * The internal state is not a stable format and there is no expectations
 * about it working across versions.
 */
export function get_state(): Promise<string | undefined>;

export function handle_wcp_cs_message(message: string): Promise<void>;

export function id_of_name(name: string): Promise<number | undefined>;

export function index_of_name(name: string): Promise<number | undefined>;

export function inject_message(message: string): void;

export function next_wcp_sc_message(): Promise<string | undefined>;

export function on_cxxrtl_sc_message(message: string): Promise<void>;

export function spade_loaded(): Promise<boolean>;

export function start_cxxrtl(): Promise<void>;

export function start_wcp(): Promise<void>;

export function waves_loaded(): Promise<boolean>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_displayeditemref_free: (a: number, b: number) => void;
    readonly __wbg_get_displayeditemref_0: (a: number) => number;
    readonly __wbg_set_displayeditemref_0: (a: number, b: number) => void;
    readonly __wbg_webhandle_free: (a: number, b: number) => void;
    readonly cxxrtl_cs_message: () => any;
    readonly draw_text_arrow: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: bigint, h: number, i: number) => any;
    readonly get_state: () => any;
    readonly handle_wcp_cs_message: (a: number, b: number) => any;
    readonly id_of_name: (a: number, b: number) => any;
    readonly index_of_name: (a: number, b: number) => any;
    readonly inject_message: (a: number, b: number) => void;
    readonly next_wcp_sc_message: () => any;
    readonly on_cxxrtl_sc_message: (a: number, b: number) => any;
    readonly spade_loaded: () => any;
    readonly start_cxxrtl: () => any;
    readonly start_wcp: () => any;
    readonly waves_loaded: () => any;
    readonly webhandle_new: () => number;
    readonly webhandle_start: (a: number, b: any) => any;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly main: (a: number, b: number) => number;
    readonly wasm_bindgen_1944aff1211aa2e3___convert__closures_____invoke___wasm_bindgen_1944aff1211aa2e3___JsValue__core_f0fd674eaa06beef___result__Result_____wasm_bindgen_1944aff1211aa2e3___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_1944aff1211aa2e3___convert__closures_____invoke___js_sys_b396104e9a5d1cb9___Function_fn_wasm_bindgen_1944aff1211aa2e3___JsValue_____wasm_bindgen_1944aff1211aa2e3___sys__Undefined___js_sys_b396104e9a5d1cb9___Function_fn_wasm_bindgen_1944aff1211aa2e3___JsValue_____wasm_bindgen_1944aff1211aa2e3___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_1944aff1211aa2e3___convert__closures_____invoke___js_sys_b396104e9a5d1cb9___Array______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_1944aff1211aa2e3___convert__closures_____invoke___js_sys_b396104e9a5d1cb9___Array______true__2: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_1944aff1211aa2e3___convert__closures_____invoke___core_f0fd674eaa06beef___result__Result_____wasm_bindgen_1944aff1211aa2e3___JsValue___true_: (a: number, b: number) => [number, number];
    readonly wasm_bindgen_1944aff1211aa2e3___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
