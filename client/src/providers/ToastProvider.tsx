import { Toaster } from "sonner";
import { CheckCircle2, AlertTriangle, XCircle, Info, Loader2 } from "lucide-react";

/** Global toast surface. Use `toast` from sonner anywhere to push messages. */
export function ToastProvider() {
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      closeButton
      richColors={false}
      className="dark"
      toastOptions={{
        classNames: {
          toast:
            "!bg-popover !border-border !text-popover-foreground !rounded-lg !shadow-xl !shadow-black/25",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
          cancelButton: "!bg-secondary !text-secondary-foreground",
        },
      }}
      icons={{
        success: <CheckCircle2 className="size-4 text-success" />,
        error: <XCircle className="size-4 text-destructive" />,
        warning: <AlertTriangle className="size-4 text-warning" />,
        info: <Info className="size-4 text-accent" />,
        loading: <Loader2 className="size-4 animate-spin text-primary" />,
      }}
    />
  );
}
