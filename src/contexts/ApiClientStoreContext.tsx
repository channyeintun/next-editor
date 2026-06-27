import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { createApiClientStore, type ApiClientStoreInstance } from "../stores/apiClientStore";

const ApiClientStoreContext = createContext<ApiClientStoreInstance | null>(null);

export function ApiClientStoreProvider({ children }: PropsWithChildren) {
  const [store] = useState(() => createApiClientStore());
  return <ApiClientStoreContext value={store}>{children}</ApiClientStoreContext>;
}

export function useApiClientStoreInstance(): ApiClientStoreInstance {
  const store = useContext(ApiClientStoreContext);
  if (!store) {
    throw new Error("useApiClientStoreInstance must be used within an ApiClientStoreProvider");
  }
  return store;
}
