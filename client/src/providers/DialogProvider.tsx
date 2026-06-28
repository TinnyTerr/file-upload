import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

interface PromptOptions extends ConfirmOptions {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  inputType?: string;
}

interface DialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

type State =
  | { kind: "none" }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<State>({ kind: "none" });
  const [value, setValue] = React.useState("");

  const confirm = React.useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setState({ kind: "confirm", opts, resolve })),
    [],
  );

  const prompt = React.useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? "");
        setState({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  const close = (result: boolean | string | null) => {
    if (state.kind === "confirm") state.resolve(result as boolean);
    if (state.kind === "prompt") state.resolve(result as string | null);
    setState({ kind: "none" });
  };

  const open = state.kind !== "none";
  const opts = state.kind !== "none" ? state.opts : null;

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      <Dialog open={open} onOpenChange={(o) => !o && close(state.kind === "prompt" ? null : false)}>
        {opts && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{opts.title}</DialogTitle>
              {opts.description && <DialogDescription>{opts.description}</DialogDescription>}
            </DialogHeader>

            {state.kind === "prompt" && (
              <form
                id="prompt-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  close(value);
                }}
                className="space-y-2"
              >
                {state.opts.label && <Label htmlFor="prompt-input">{state.opts.label}</Label>}
                <Input
                  id="prompt-input"
                  autoFocus
                  type={state.opts.inputType ?? "text"}
                  placeholder={state.opts.placeholder}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </form>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => close(state.kind === "prompt" ? null : false)}>
                {opts.cancelText ?? "Cancel"}
              </Button>
              <Button
                variant={opts.destructive ? "destructive" : "default"}
                type={state.kind === "prompt" ? "submit" : "button"}
                form={state.kind === "prompt" ? "prompt-form" : undefined}
                onClick={state.kind === "confirm" ? () => close(true) : undefined}
              >
                {opts.confirmText ?? "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </DialogContext.Provider>
  );
}

export function useDialogs() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs must be used within DialogProvider");
  return ctx;
}
