import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./components/App.tsx";
import "./styles/global.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Inbox polls every 30s; the BFF is local so retries don't help much.
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
