'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Monitor,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  Download,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { DeviceStatusBadge } from '@/components/DeviceStatusBadge';
import { useDevices, useToast } from '@/lib/hooks';
import { updateDevice, deleteDevice, type Device } from '@/lib/api';
import clsx from 'clsx';

function formatRelativeTime(ts: number | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - ts * 1000; // ts is unix seconds
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Add Device Modal
function AddDeviceModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-dark-surface border border-dark-border rounded-2xl p-7 w-full max-w-md shadow-2xl animate-slide-in">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold text-dark-text">Add a Device</h2>
            <p className="text-sm text-dark-muted mt-0.5">Install the DoomsDesk agent on your device</p>
          </div>
          <button onClick={onClose} className="text-dark-muted hover:text-dark-text transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="bg-accent/8 border border-accent/20 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center">
                <Download size={15} className="text-accent" />
              </div>
              <div>
                <p className="text-sm font-semibold text-dark-text">Step 1: Download the agent</p>
                <p className="text-xs text-dark-muted">Available for Windows, macOS, and Linux</p>
              </div>
            </div>
            <a
              href="https://doomsdesk.io/download"
              target="_blank"
              rel="noreferrer"
              className="btn-primary text-xs inline-flex items-center gap-1.5"
            >
              <Download size={13} />
              Download Agent
            </a>
          </div>

          <div className="bg-dark-bg border border-dark-border rounded-xl p-4 space-y-2">
            <p className="text-sm font-semibold text-dark-text">Step 2: Install and sign in</p>
            <p className="text-xs text-dark-muted leading-relaxed">
              Run the installer, sign in with your DoomsDesk account, and the device will appear here automatically within seconds.
            </p>
          </div>

          <div className="bg-dark-bg border border-dark-border rounded-xl p-4 space-y-2">
            <p className="text-sm font-semibold text-dark-text">Step 3: Connect</p>
            <p className="text-xs text-dark-muted leading-relaxed">
              Once the agent is running, your device shows as <span className="text-success font-medium">Online</span>. Use Quick Connect on the dashboard to take control.
            </p>
          </div>
        </div>

        <button onClick={onClose} className="btn-secondary w-full mt-6">
          Got it
        </button>
      </div>
    </div>
  );
}

// Edit Device Modal
function EditDeviceModal({
  device,
  onClose,
  onSave,
}: {
  device: Device;
  onClose: () => void;
  onSave: (id: string, data: { name?: string; permanentPassword?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(device.name);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    await onSave(device.id, { name, ...(password ? { permanentPassword: password } : {}) });
    setSaving(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-dark-surface border border-dark-border rounded-2xl p-7 w-full max-w-sm shadow-2xl animate-slide-in">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-dark-text">Edit Device</h2>
          <button onClick={onClose} className="text-dark-muted hover:text-dark-text transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">Device Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="input-base"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
              New Password <span className="normal-case font-normal text-dark-muted/60">(optional)</span>
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current"
              className="input-base"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 flex items-center justify-center gap-2">
              {saving ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Check size={15} />
              )}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Delete confirm modal
function DeleteModal({ device, onClose, onConfirm }: { device: Device; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-dark-surface border border-dark-border rounded-2xl p-7 w-full max-w-sm shadow-2xl animate-slide-in">
        <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-4">
          <AlertTriangle size={22} className="text-danger" />
        </div>
        <h2 className="text-lg font-bold text-dark-text text-center mb-1">Remove Device?</h2>
        <p className="text-sm text-dark-muted text-center mb-6">
          <span className="font-medium text-dark-text">{device.name}</span> will be removed and can no longer be accessed remotely.
        </p>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button
            onClick={async () => {
              setLoading(true);
              await onConfirm();
              setLoading(false);
              onClose();
            }}
            disabled={loading}
            className="btn-danger flex-1 flex items-center justify-center gap-2"
          >
            {loading ? <span className="w-4 h-4 border-2 border-danger/30 border-t-danger rounded-full animate-spin" /> : null}
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DevicesPage() {
  const { devices, loading, refresh } = useDevices();
  const { toasts, addToast, removeToast } = useToast();
  const router = useRouter();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editDevice, setEditDevice] = useState<Device | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);

  async function handleUpdateDevice(id: string, data: { name?: string; permanentPassword?: string }) {
    try {
      await updateDevice(id, data);
      addToast('Device updated', 'success');
      refresh();
    } catch {
      addToast('Failed to update device', 'error');
    }
  }

  async function handleDeleteDevice(id: string) {
    try {
      await deleteDevice(id);
      addToast('Device removed', 'success');
      refresh();
    } catch {
      addToast('Failed to remove device', 'error');
    }
  }

  function handleConnect(deviceId: string) {
    router.push(`/viewer?id=${encodeURIComponent(deviceId)}`);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-dark-text">Devices</h1>
          <p className="text-sm text-dark-muted mt-1">{devices.length} device{devices.length !== 1 ? 's' : ''} registered</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="btn-secondary flex items-center gap-2"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus size={16} />
            Add Device
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-dark-surface border border-dark-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse bg-dark-border/40 rounded-lg h-16" />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <div className="py-20 text-center">
            <Monitor size={40} className="text-dark-muted/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-dark-muted">No devices yet</p>
            <p className="text-xs text-dark-muted/60 mt-1 mb-5">Install the DoomsDesk agent to get started</p>
            <button onClick={() => setShowAddModal(true)} className="btn-primary inline-flex items-center gap-2">
              <Plus size={15} />
              Add your first device
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dark-border">
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Device</th>
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">ID</th>
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Status</th>
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Last Seen</th>
                <th className="text-right text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device, i) => (
                <tr
                  key={device.id}
                  className={clsx(
                    'border-b border-dark-border/50 hover:bg-dark-border/15 transition-colors animate-fade-in',
                  )}
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className={clsx(
                        'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                        device.online ? 'bg-success/10' : 'bg-dark-border/60'
                      )}>
                        <Monitor size={15} className={device.online ? 'text-success' : 'text-dark-muted'} />
                      </div>
                      <span className="font-medium text-dark-text">{device.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <code className="text-xs text-dark-muted font-mono bg-dark-bg px-2 py-1 rounded border border-dark-border">
                      {device.deviceId}
                    </code>
                  </td>
                  <td className="px-5 py-4">
                    <DeviceStatusBadge status={device.online ? 'online' : 'offline'} />
                  </td>
                  <td className="px-5 py-4 text-xs text-dark-muted">
                    {device.online ? (
                      <span className="text-success">Now</span>
                    ) : (
                      formatRelativeTime(device.lastSeen)
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center justify-end gap-1.5">
                      {device.online && (
                        <button
                          onClick={() => handleConnect(device.deviceId)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors font-medium"
                        >
                          Take Control
                        </button>
                      )}
                      <button
                        onClick={() => setEditDevice(device)}
                        className="p-1.5 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(device)}
                        className="p-1.5 rounded-lg text-dark-muted hover:text-danger hover:bg-danger/10 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      {showAddModal && <AddDeviceModal onClose={() => setShowAddModal(false)} />}
      {editDevice && (
        <EditDeviceModal
          device={editDevice}
          onClose={() => setEditDevice(null)}
          onSave={handleUpdateDevice}
        />
      )}
      {deleteTarget && (
        <DeleteModal
          device={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => handleDeleteDevice(deleteTarget.id)}
        />
      )}

      {/* Toast notifications */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              'flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl text-sm font-medium animate-slide-in cursor-pointer',
              toast.type === 'success' && 'bg-success/10 border-success/30 text-success',
              toast.type === 'error' && 'bg-danger/10 border-danger/30 text-danger',
              toast.type === 'info' && 'bg-dark-surface border-dark-border text-dark-text',
            )}
            onClick={() => removeToast(toast.id)}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
