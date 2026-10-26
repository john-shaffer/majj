import * as vscode from "vscode";

/** An open prompt that tests can read and answer as if typed. */
export interface Prompt {
  title: string;
  answer(input: string): void;
}

let active: Prompt | undefined;

/** The open prompt, if any. */
export function activePrompt(): Prompt | undefined {
  return active;
}

/** Makes `prompt` the open one until the returned function is called. */
export function openPrompt(prompt: Prompt): () => void {
  active = prompt;
  return () => {
    if (active === prompt) {
      active = undefined;
    }
  };
}

export function promptInput(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const inputBox = vscode.window.createInputBox();
    inputBox.prompt = prompt;

    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      close();
      inputBox.hide();
      resolve(value?.trim() || undefined);
    };

    const close = openPrompt({ title: prompt, answer: finish });
    const acceptSub = inputBox.onDidAccept(() => finish(inputBox.value));
    const hideSub = inputBox.onDidHide(() => {
      acceptSub.dispose();
      hideSub.dispose();
      inputBox.dispose();
      finish(undefined);
    });

    inputBox.show();
  });
}
