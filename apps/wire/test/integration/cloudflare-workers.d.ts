/** Use the installed official RPC types without replacing Bun's test-runner globals. */
declare module "cloudflare:workers" {
  export const WorkerEntrypoint: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.WorkerEntrypoint;
}
