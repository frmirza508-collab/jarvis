/* Values injected by the release build (esbuild `define`). In development they fall back to env vars. */
declare const __JARVIS_RELEASE__: boolean | undefined;
declare const __JARVIS_VERSION__: string | undefined;
declare const __LICENSE_PUBLIC_KEY__: string | undefined;
declare const __LICENSE_API_URL__: string | undefined;

export const IS_RELEASE: boolean = typeof __JARVIS_RELEASE__ !== 'undefined' && __JARVIS_RELEASE__ === true;
export const APP_VERSION: string =
  typeof __JARVIS_VERSION__ !== 'undefined' ? __JARVIS_VERSION__ : '0.1.0-dev';

/** Release builds embed the license PUBLIC key; env overrides are ignored in release. */
export const LICENSE_PUBLIC_KEY: string | undefined = IS_RELEASE
  ? typeof __LICENSE_PUBLIC_KEY__ !== 'undefined'
    ? __LICENSE_PUBLIC_KEY__
    : undefined
  : process.env.JARVIS_LICENSE_PUBLIC_KEY?.replace(/\\n/g, '\n');

export const LICENSE_API_URL: string =
  (IS_RELEASE
    ? typeof __LICENSE_API_URL__ !== 'undefined'
      ? __LICENSE_API_URL__
      : undefined
    : process.env.JARVIS_LICENSE_API_URL) ?? 'http://127.0.0.1:8787';

/** Development license bypass is impossible in release builds. */
export const DEVELOPMENT_LICENSE_MODE: boolean =
  !IS_RELEASE && process.env.JARVIS_LICENSE_MODE === 'development';
