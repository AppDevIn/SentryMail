import { useEffect, useState } from "react";
import { api } from "../api";
import type { UnsubscribeInfo } from "../types";

interface UnsubscribeControlProps {
  emailId: number;
}

type Step = "idle" | "confirming" | "working" | "done" | "error";

export function UnsubscribeControl({ emailId }: UnsubscribeControlProps) {
  const [info, setInfo] = useState<UnsubscribeInfo | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInfo(null);
    setStep("idle");
    setError(null);
    api.unsubscribeInfo(emailId).then(setInfo);
  }, [emailId]);

  if (!info || info.method.kind === "unavailable") {
    return null;
  }

  if (info.unsubscribed_at) {
    return <p className="unsubscribe-status">Unsubscribed</p>;
  }

  const run = async (action: () => Promise<void>) => {
    setStep("working");
    setError(null);
    try {
      await action();
      setStep("done");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  if (step === "done") {
    return <p className="unsubscribe-status">Unsubscribed</p>;
  }

  const method = info.method;
  let label: string;
  let confirmText: string;
  let onConfirm: () => Promise<void>;
  let isSendPath = false;

  if (method.kind === "one_click_post") {
    label = "Unsubscribe";
    confirmText = "Send a one-click unsubscribe request? No email will be sent.";
    onConfirm = () => api.unsubscribeViaPost(emailId);
  } else if (method.kind === "browser") {
    label = "Unsubscribe";
    confirmText = "Open the unsubscribe page in your browser?";
    onConfirm = () => api.unsubscribeOpenBrowser(emailId);
  } else {
    label = "Unsubscribe by email";
    confirmText = `This will send an email to ${method.to} from your account to unsubscribe. Continue?`;
    onConfirm = () => api.unsubscribeViaMailto(emailId);
    isSendPath = true;
  }

  const className = isSendPath ? "unsubscribe-control unsubscribe-send" : "unsubscribe-control";

  return (
    <div className={className}>
      {step === "idle" && (
        <button onClick={() => setStep("confirming")}>{label}</button>
      )}
      {step === "confirming" && (
        <div className="unsubscribe-confirm">
          <p>{confirmText}</p>
          <button onClick={() => run(onConfirm)}>Confirm</button>
          <button onClick={() => setStep("idle")}>Cancel</button>
        </div>
      )}
      {step === "working" && <p>Working…</p>}
      {step === "error" && (
        <p className="unsubscribe-error">
          {error}{" "}
          <button onClick={() => setStep("idle")}>Try again</button>
        </p>
      )}
    </div>
  );
}
