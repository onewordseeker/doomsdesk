'use client';

import { useState, useEffect, FormEvent, useCallback } from 'react';
import {
  Users,
  UserPlus,
  Trash2,
  Crown,
  Shield,
  Eye,
  Plus,
  X,
  ChevronDown,
  Check,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { useTeams, useToast } from '@/lib/hooks';
import {
  createTeam,
  deleteTeam,
  getTeamMembers,
  inviteTeamMember,
  removeTeamMember,
  updateMemberRole,
  type Team,
  type TeamMember,
} from '@/lib/api';
import clsx from 'clsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(ts * 1000));
}

const ROLE_META: Record<
  TeamMember['role'],
  { label: string; icon: typeof Crown; className: string }
> = {
  owner: { label: 'Owner', icon: Crown, className: 'text-yellow-400 bg-yellow-400/10' },
  admin: { label: 'Admin', icon: Shield, className: 'text-accent bg-accent/10' },
  member: { label: 'Member', icon: Users, className: 'text-dark-text bg-dark-border/60' },
  viewer: { label: 'Viewer', icon: Eye, className: 'text-dark-muted bg-dark-border/40' },
};

function RoleBadge({ role }: { role: TeamMember['role'] }) {
  const meta = ROLE_META[role];
  const Icon = meta.icon;
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full', meta.className)}>
      <Icon size={11} />
      {meta.label}
    </span>
  );
}

// ─── Create Team Modal ────────────────────────────────────────────────────────

function CreateTeamModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createTeam(name.trim());
      onCreated();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-dark-surface border border-dark-border rounded-2xl p-7 w-full max-w-sm shadow-2xl animate-slide-in">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold text-dark-text">Create Team</h2>
            <p className="text-sm text-dark-muted mt-0.5">Collaborate with your organization</p>
          </div>
          <button onClick={onClose} className="text-dark-muted hover:text-dark-text transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
              Team Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Engineering, DevOps"
              required
              className="input-base"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-xs text-danger bg-danger/8 border border-danger/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {saving ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Check size={15} />
              )}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Delete Team Modal ────────────────────────────────────────────────────────

function DeleteTeamModal({
  team,
  onClose,
  onDeleted,
}: {
  team: Team;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      await deleteTeam(team.id);
      onDeleted();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-dark-surface border border-dark-border rounded-2xl p-7 w-full max-w-sm shadow-2xl animate-slide-in">
        <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-4">
          <AlertTriangle size={22} className="text-danger" />
        </div>
        <h2 className="text-lg font-bold text-dark-text text-center mb-1">Delete Team?</h2>
        <p className="text-sm text-dark-muted text-center mb-2">
          <span className="font-medium text-dark-text">{team.name}</span> and all its members will be permanently removed.
          This action cannot be undone.
        </p>
        {error && (
          <p className="text-xs text-danger bg-danger/8 border border-danger/20 rounded-lg px-3 py-2 mb-3 text-center">
            {error}
          </p>
        )}
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="btn-secondary flex-1">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="btn-danger flex-1 flex items-center justify-center gap-2"
          >
            {loading ? (
              <span className="w-4 h-4 border-2 border-danger/30 border-t-danger rounded-full animate-spin" />
            ) : null}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Invite Member Modal ──────────────────────────────────────────────────────

function InviteMemberModal({
  team,
  onClose,
  onInvited,
}: {
  team: Team;
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('member');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await inviteTeamMember(team.id, email.trim(), role);
      onInvited();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-dark-surface border border-dark-border rounded-2xl p-7 w-full max-w-sm shadow-2xl animate-slide-in">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold text-dark-text">Invite Member</h2>
            <p className="text-sm text-dark-muted mt-0.5">Add someone to {team.name}</p>
          </div>
          <button onClick={onClose} className="text-dark-muted hover:text-dark-text transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              required
              className="input-base"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
              Role
            </label>
            <div className="relative">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="input-base appearance-none pr-8"
              >
                <option value="admin">Admin — can manage members and devices</option>
                <option value="member">Member — can access devices</option>
                <option value="viewer">Viewer — read-only access</option>
              </select>
              <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-muted pointer-events-none" />
            </div>
          </div>

          {error && (
            <p className="text-xs text-danger bg-danger/8 border border-danger/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !email.trim()}
              className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {saving ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <UserPlus size={15} />
              )}
              Invite
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Team Members Panel ───────────────────────────────────────────────────────

function TeamMembersPanel({
  team,
  currentUserIsOwnerOrAdmin,
  onRefreshTeams,
  addToast,
}: {
  team: Team;
  currentUserIsOwnerOrAdmin: boolean;
  onRefreshTeams: () => void;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const data = await getTeamMembers(team.id);
      setMembers(data.members);
    } catch {
      // silently ignore — parent will show error
    } finally {
      setMembersLoading(false);
    }
  }, [team.id]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  async function handleRemoveMember(userId: string) {
    try {
      await removeTeamMember(team.id, userId);
      addToast('Member removed', 'success');
      fetchMembers();
    } catch (err) {
      addToast((err as Error).message, 'error');
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    setUpdatingRole(userId);
    try {
      await updateMemberRole(team.id, userId, newRole);
      addToast('Role updated', 'success');
      fetchMembers();
    } catch (err) {
      addToast((err as Error).message, 'error');
    } finally {
      setUpdatingRole(null);
    }
  }

  return (
    <div className="border-t border-dark-border/60 bg-dark-bg/40 px-5 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-dark-muted uppercase tracking-wider">Members</p>
        {currentUserIsOwnerOrAdmin && (
          <button
            onClick={() => setShowInvite(true)}
            className="flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/80 transition-colors"
          >
            <UserPlus size={13} />
            Invite
          </button>
        )}
      </div>

      {membersLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="animate-pulse bg-dark-border/30 rounded-lg h-10" />
          ))}
        </div>
      ) : members.length === 0 ? (
        <p className="text-xs text-dark-muted/60 py-2">No members yet.</p>
      ) : (
        <div className="space-y-1.5">
          {members.map((member) => (
            <div
              key={member.userId}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-dark-surface/60 border border-dark-border/40 hover:border-dark-border/80 transition-colors"
            >
              {/* Avatar */}
              <div className="w-7 h-7 rounded-full bg-accent/15 border border-accent/20 flex items-center justify-center flex-shrink-0">
                <span className="text-[10px] font-bold text-accent">
                  {(member.name ?? member.email ?? member.userId).charAt(0).toUpperCase()}
                </span>
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                {member.name && (
                  <p className="text-xs font-semibold text-dark-text truncate">{member.name}</p>
                )}
                <p className="text-[11px] text-dark-muted truncate">
                  {member.email ?? member.userId}
                </p>
              </div>

              {/* Role */}
              {currentUserIsOwnerOrAdmin && member.role !== 'owner' ? (
                <div className="relative flex-shrink-0">
                  <select
                    value={member.role}
                    onChange={(e) => handleRoleChange(member.userId, e.target.value)}
                    disabled={updatingRole === member.userId}
                    className={clsx(
                      'text-xs font-semibold rounded-full px-2.5 py-1 border appearance-none pr-6 cursor-pointer transition-colors',
                      'bg-dark-bg border-dark-border text-dark-text',
                      'hover:border-accent/40 focus:outline-none focus:border-accent/60',
                      updatingRole === member.userId && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-muted pointer-events-none" />
                </div>
              ) : (
                <RoleBadge role={member.role} />
              )}

              {/* Remove */}
              {currentUserIsOwnerOrAdmin && member.role !== 'owner' && (
                <button
                  onClick={() => handleRemoveMember(member.userId)}
                  className="p-1.5 rounded-lg text-dark-muted hover:text-danger hover:bg-danger/10 transition-colors flex-shrink-0"
                  title="Remove member"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showInvite && (
        <InviteMemberModal
          team={team}
          onClose={() => setShowInvite(false)}
          onInvited={fetchMembers}
        />
      )}
    </div>
  );
}

// ─── Team Card ────────────────────────────────────────────────────────────────

function TeamCard({
  team,
  onRefresh,
  addToast,
}: {
  team: Team;
  onRefresh: () => void;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  // For demo purposes, assume the logged-in user is always owner/admin.
  // In a real app, compare team.ownerId to auth user id.
  const currentUserIsOwnerOrAdmin = true;
  const isOwner = true;

  return (
    <div className="bg-dark-surface border border-dark-border rounded-xl overflow-hidden transition-colors hover:border-dark-border/80 animate-fade-in">
      {/* Card header */}
      <div
        className="flex items-center gap-4 px-5 py-4 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Icon */}
        <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0">
          <Users size={18} className="text-accent" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-dark-text">{team.name}</h3>
            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
              {team.plan}
            </span>
            {isOwner && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded-full">
                <Crown size={10} />
                Owner
              </span>
            )}
          </div>
          <p className="text-xs text-dark-muted mt-0.5">Created {formatDate(team.createdAt)}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {isOwner && (
            <button
              onClick={() => setShowDelete(true)}
              className="p-1.5 rounded-lg text-dark-muted hover:text-danger hover:bg-danger/10 transition-colors"
              title="Delete team"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className={clsx(
              'p-1.5 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 transition-all duration-200',
              expanded && 'rotate-180'
            )}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>

      {/* Expanded members panel */}
      {expanded && (
        <TeamMembersPanel
          team={team}
          currentUserIsOwnerOrAdmin={currentUserIsOwnerOrAdmin}
          onRefreshTeams={onRefresh}
          addToast={addToast}
        />
      )}

      {/* Delete modal */}
      {showDelete && (
        <DeleteTeamModal
          team={team}
          onClose={() => setShowDelete(false)}
          onDeleted={onRefresh}
        />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TeamsPage() {
  const { teams, loading, error, refresh } = useTeams();
  const { toasts, addToast, removeToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-dark-text">Teams</h1>
          <p className="text-sm text-dark-muted mt-1">
            {teams.length > 0
              ? `${teams.length} team${teams.length !== 1 ? 's' : ''}`
              : 'Manage collaborative access to your devices'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="btn-secondary flex items-center gap-2" title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
            <Plus size={16} />
            Create Team
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-danger/8 border border-danger/20 rounded-xl px-5 py-4 flex items-center gap-3">
          <AlertTriangle size={16} className="text-danger flex-shrink-0" />
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="animate-pulse bg-dark-surface border border-dark-border rounded-xl h-20" />
          ))}
        </div>
      ) : teams.length === 0 ? (
        <div className="bg-dark-surface border border-dark-border rounded-xl py-20 text-center">
          <div className="w-14 h-14 rounded-full bg-dark-border/40 flex items-center justify-center mx-auto mb-4">
            <Users size={28} className="text-dark-muted/40" />
          </div>
          <p className="text-sm font-medium text-dark-muted">No teams yet</p>
          <p className="text-xs text-dark-muted/60 mt-1 mb-5">
            Create your first team to collaborate with others.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="btn-primary inline-flex items-center gap-2"
          >
            <Plus size={15} />
            Create your first team
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {teams.map((team, i) => (
            <div key={team.id} style={{ animationDelay: `${i * 40}ms` }}>
              <TeamCard team={team} onRefresh={refresh} addToast={addToast} />
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateTeamModal
          onClose={() => setShowCreate(false)}
          onCreated={refresh}
        />
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              'flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl text-sm font-medium animate-slide-in cursor-pointer',
              toast.type === 'success' && 'bg-success/10 border-success/30 text-success',
              toast.type === 'error' && 'bg-danger/10 border-danger/30 text-danger',
              toast.type === 'info' && 'bg-dark-surface border-dark-border text-dark-text'
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
