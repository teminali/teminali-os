/** @jsxImportSource @opentui/solid */

const tui = async (api) => {
  api.slots.register({
    id: "frontier.branding",
    slots: {
      home_logo() {
        return (
          <box flexDirection="column" alignItems="center">
            <text fg="#38bdf8" bold={true}>█▀▀ █▀▀█ █▀▀█ █▀▄█ ▀█▀ █ █▀▀█ █▀▀█   █▀▀▀ █▀▀█ █▀▀█ █▀▀█</text>
            <text fg="#cbd5e1" bold={true}>█▀▀ █▀▀▄ █  █ █  █  █  █ █▀▀▀ █▀▀▄   █    █  █ █  █ █▀▀▀</text>
            <text fg="#64748b" bold={true}>▀   ▀  ▀ ▀▀▀▀ ▀  ▀  ▀  ▀ ▀▀▀▀ ▀  ▀   ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀</text>
          </box>
        );
      },
    },
  });
};

export default {
  id: "frontier.branding",
  tui,
};
