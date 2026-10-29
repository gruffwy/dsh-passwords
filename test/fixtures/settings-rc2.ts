// Relevant host-backed settings mirror contract from the official
// @deepseek-ai/dsh-client-ui-settings@0.2.1-rc.2 lib/client.js.
// The complete published artifact is also checked separately during acceptance.
export const RC2_NATIVE_SETTINGS = `
var SettingsDescribeMirror = class {
  async run() {
    const response = await this.ctx.remote.settings.describe();
    const outcome = response.ok ? { view: response.value } : { failure: response.error.message };
    return outcome;
  }
};
const inject = ["remote", "remote.settings"];
function apply(ctx) {
  const mirror = new SettingsDescribeMirror(ctx);
  ctx.effect(() => {
    const disposers = [ctx.remote.$on("settings/document-updated", () => {
      mirror.load();
    }), ctx.on("connection/reset", () => {
      mirror.load();
    })];
    mirror.ensure();
    return () => { for (const dispose of disposers) dispose(); };
  }, "ui-settings: describe mirror invalidations");
}
`;
