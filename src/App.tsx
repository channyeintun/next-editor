import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import { CollaborationRealtimeProvider } from "@next-editor/infra";

import { queryClient } from "./queryClient";
import { router } from "./router";

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <CollaborationRealtimeProvider>
        <RouterProvider router={router} />
      </CollaborationRealtimeProvider>
    </QueryClientProvider>
  );
}

export default App;
