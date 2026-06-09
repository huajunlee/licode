export type AppView = "welcome" | "chat";

export interface AppViewState {
  view: AppView;
}

export function createAppViewState(initialSessionId?: string): AppViewState {
  return { view: initialSessionId ? "chat" : "welcome" };
}

export function appViewReducer(
  state: AppViewState,
  action: "enter-chat" | "go-back"
): AppViewState {
  switch (action) {
    case "enter-chat":
      return { view: "chat" };
    case "go-back":
      if (state.view === "chat") return { view: "welcome" };
      return state;
  }
}
