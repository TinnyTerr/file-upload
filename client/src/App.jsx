import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Toaster from './components/Toaster.jsx';
import DialogManager from './components/DialogManager.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ChangePage from './pages/ChangePage.jsx';
import FilesPage from './pages/FilesPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import DownloadPage from './pages/DownloadPage.jsx';
import DirectoryPage from './pages/DirectoryPage.jsx';
import DropboxPage from './pages/DropboxPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Toaster />
      <DialogManager />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/account/change" element={<ChangePage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/file/:slug" element={<DownloadPage />} />
        <Route path="/d/:slug" element={<DirectoryPage />} />
        <Route path="/dropbox/:token" element={<DropboxPage />} />
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
