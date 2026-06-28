import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { authService } from "../services/authService";
import { useAuth } from "./auth";
import { ApiError, errorMessage } from "@/config/api";

interface LocationState {
  from?: string;
}

export function useLogin() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login(username: string, password: string) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await authService.login(username, password);
      await refresh();
      const dest = res.must_change_credentials
        ? "/account/change"
        : ((location.state as LocationState)?.from ?? "/files");
      toast.success("Welcome back");
      navigate(dest, { replace: true });
    } catch (err) {
      let msg = errorMessage(err);
      if (err instanceof ApiError) {
        if (err.status === 401) msg = "Invalid username or password.";
        else if (err.status === 429) msg = "Too many attempts — try again later.";
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return { login, submitting, error };
}
