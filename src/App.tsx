import { createBrowserRouter, RouterProvider } from 'react-router-dom';

const router = createBrowserRouter([
  {
    path: '/',
    lazy: () => import('./components/LandingPage').then(m => ({ Component: m.default })),
  },
  {
    path: '/code',
    lazy: () => import('./components/Editor').then(m => ({ Component: m.default })),
  },
]);

function App() {
  return <RouterProvider router={router} />;
}

export default App;