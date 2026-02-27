import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { napcatChannel } from "./src/channel.js";
import { setNapCatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcatqq",
  name: "QQ (NapCat)",
  description: "QQ channel via NapCatQQ OneBot v11 WebSocket",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 保存 PluginRuntime 供 gateway/outbound 使用
    setNapCatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatChannel as ChannelPlugin });
  },
};

export default plugin;
