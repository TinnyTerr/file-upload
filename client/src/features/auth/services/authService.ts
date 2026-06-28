import { api, setCsrfToken } from "@/config/api";

export interface LoginResponse {
  csrf_token: string;
  must_change_credentials: boolean;
}

export const authService = {
  login: async (username: string, password: string) => {
    const res = await api.post<LoginResponse>("/auth/login", {
      json: { username, password },
    });
    setCsrfToken(res.csrf_token);
    return res;
  },

  logout: async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      setCsrfToken(null);
    }
  },
};
