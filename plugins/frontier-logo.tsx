/** @jsxImportSource @opentui/solid */

const tui = async (api) => {
  api.slots.register({
    id: "frontier.branding",
    slots: {
      home_logo() {
        return (
          <box flexDirection="column" alignItems="center">
            <box flexDirection="row" gap={2}>
              <box flexDirection="column">
                <text fg="#38bdf8" bold={true}>█▀▀▀ █▀▀█ █▀▀█ █▄ █</text>
                <text fg="#38bdf8" bold={true}>█▀▀  █▄▄▀ █  █ █ ▀█</text>
                <text fg="#38bdf8" bold={true}>▀    ▀  ▀ ▀▀▀▀ ▀  ▀</text>
              </box>
              <box flexDirection="column">
                <text fg="#f8fafc" bold={true}>▀█▀ █ █▀▀█ █▀▀█</text>
                <text fg="#f8fafc" bold={true}> █  █ █▀▀  █▄▄▀</text>
                <text fg="#f8fafc" bold={true}> ▀  ▀ ▀▀▀▀ ▀  ▀</text>
              </box>
            </box>
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
