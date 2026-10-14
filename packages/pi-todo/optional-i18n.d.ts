// Minimal types for the soft optional peer; no runtime dependency is required.
declare module "@juicesharp/rpiv-i18n" {
	export function scope(namespace: string): (key: string, fallback: string) => string;
}
declare module "@juicesharp/rpiv-i18n/loader" {
	export function registerLocalesFromDir(namespace: string, packageUrl: string, options?: { label?: string }): void;
}
