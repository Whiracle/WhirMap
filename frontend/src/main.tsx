import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  addEdge,
  Background,
  Connection,
  Controls,
  Edge,
  Handle,
  MiniMap,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';

type Role = 'admin' | 'member';
type NodeStatus = 'up' | 'down' | 'unknown' | 'disabled' | string;
type DrawerSection = 'map' | 'account' | 'actions' | 'types' | 'groups' | 'members' | 'help';

type GroupUserBrief = {
  id: string;
  username: string;
  role: Role;
  isActive: boolean;
};

type GroupDeviceBrief = {
  id: string;
  label: string;
  status: string;
  ip?: string | null;
  mapId?: string | null;
};

type Group = {
  id: string;
  name: string;
  description?: string | null;
  users?: GroupUserBrief[];
  deviceCount?: number;
  devices?: GroupDeviceBrief[];
};

type DeviceType = {
  id: string;
  name: string;
  icon: string;
};

type User = {
  id: string;
  username: string;
  role: Role;
  isActive: boolean;
  groupIds: string[];
  groupNames?: string[];
  createdAt?: string | null;
};

type AuthState = {
  token: string;
  user: User;
};

type NodeData = Record<string, unknown> & {
  label: string;
  deviceType: string;
  deviceTypeName: string;
  deviceIcon: string;
  groupIds: string[];
  ip?: string | null;
  childMapId?: string | null;
  monitorEnabled: boolean;
  status: NodeStatus;
  ownStatus?: string;
  latencyMs?: number | null;
  lastCheckedAt?: string | null;
};

type AppNode = Node<NodeData, 'networkNode'>;

type MapResponse = {
  id: string;
  name: string;
  breadcrumbs: Array<{ id: string; name: string }>;
  nodes: AppNode[];
  edges: Edge[];
};

type HistoryItem = {
  id: number;
  status: string;
  latencyMs?: number | null;
  startedAt?: string | null;
  lastSeenAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  isOpen: boolean;
  source: string;
};

type HistoryResponse = {
  nodeId: string;
  nodeLabel: string;
  summary: {
    events: number;
    upEvents: number;
    downEvents: number;
    totalDowntimeSeconds: number;
    currentStatus: string;
    lastCheckedAt?: string | null;
  };
  items: HistoryItem[];
};


type NotificationItem = {
  id: number;
  nodeId: string;
  nodeLabel: string;
  nodeIp?: string | null;
  mapId?: string | null;
  mapPath?: string | null;
  status: string;
  title: string;
  message: string;
  createdAt?: string | null;
};

type NotificationsResponse = {
  total: number;
  items: NotificationItem[];
};

type SearchResult = {
  nodeId: string;
  label: string;
  ip?: string | null;
  status: string;
  ownStatus?: string;
  latencyMs?: number | null;
  lastCheckedAt?: string | null;
  mapId: string;
  mapName: string;
  mapPath: string;
  deviceTypeName: string;
  deviceIcon: string;
  groupIds: string[];
  groupNames: string[];
};

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
};

type ContextPopover =
  | { kind: 'node'; id: string; x: number; y: number }
  | { kind: 'edge'; id: string; x: number; y: number };

const API = '';
const AUTH_STORAGE_KEY = 'whirmap-auth';
const ICON_OPTIONS = ['📦', '🖥️', '🖧', '📡', '🧱', '☁️', '🏢', '🗄️', '🛜', '🔌', '🛰️', '💾', '🖨️', '📱', '🔐'];

function statusLabel(status: string) {
  if (status === 'up') return 'UP';
  if (status === 'down') return 'DOWN';
  if (status === 'unknown') return 'UNKNOWN';
  return 'DISABLED';
}

function displayDeviceTypeName(name?: string | null) {
  if (!name) return 'Device';
  return name.toLowerCase() === 'device' ? 'Device' : name;
}

function formatDate(value?: string | null) {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

function formatDuration(totalSeconds?: number | null) {
  if (totalSeconds == null) return 'n/a';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length && seconds) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function popoverStyle(x: number, y: number, width = 390) {
  const margin = 16;
  const estimatedHeight = Math.min(window.innerHeight - margin * 2, 640);
  return {
    left: clampNumber(x, margin, Math.max(margin, window.innerWidth - width - margin)),
    top: clampNumber(y, margin, Math.max(margin, window.innerHeight - estimatedHeight - margin)),
  };
}

function eventTitle(item: HistoryItem) {
  if (item.status === 'down') return item.isOpen ? 'DOWN since' : 'DOWN interval';
  if (item.status === 'up') return item.isOpen ? 'UP since' : 'UP interval';
  return item.isOpen ? `${statusLabel(item.status)} since` : `${statusLabel(item.status)} interval`;
}

function groupNamesForIds(groupIds: string[], groups: Group[]) {
  const byId = new Map(groups.map((group) => [group.id, group.name]));
  return groupIds.map((id) => byId.get(id) ?? id).join(', ') || 'no groups';
}

function NetworkNode({ data, selected }: NodeProps<AppNode>) {
  return (
    <div className={`network-node status-${data.status} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="node-topline">
        <span className="node-icon">{data.deviceIcon || '📦'}</span>
        <strong>{data.label}</strong>
        {data.childMapId && <span className="child-badge">↳ map</span>}
      </div>
      <div className="node-subline">{displayDeviceTypeName(data.deviceTypeName)}{data.ip ? ` · ${data.ip}` : ''}</div>
      <div className="node-status">
        <span className="dot" />
        {statusLabel(data.status)}
        {data.latencyMs != null ? ` · ${data.latencyMs} ms` : ''}
      </div>
    </div>
  );
}

function AccordionSection({
  id,
  title,
  active,
  setActive,
  children,
}: {
  id: DrawerSection;
  title: string;
  active: DrawerSection;
  setActive: (id: DrawerSection) => void;
  children: React.ReactNode;
}) {
  const open = active === id;
  return (
    <div className={`accordion ${open ? 'open' : ''}`}>
      <button className="accordion-header" onClick={() => setActive(id)}>
        <span>{title}</span>
        <span>{open ? '−' : '+'}</span>
      </button>
      {open && <div className="accordion-body">{children}</div>}
    </div>
  );
}

function readStoredAuth(): AuthState | null {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthState;
  } catch {
    return null;
  }
}

function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => readStoredAuth());
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('admin123');
  const [loginError, setLoginError] = useState('');

  const [currentMapId, setCurrentMapId] = useState('root');
  const [mapName, setMapName] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<DrawerSection>('map');
  const [contextPopover, setContextPopover] = useState<ContextPopover | null>(null);
  const [nodeModalOpen, setNodeModalOpen] = useState(false);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationSearch, setNotificationSearch] = useState('');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationTotal, setNotificationTotal] = useState(0);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');

  const [groups, setGroups] = useState<Group[]>([]);
  const [deviceTypes, setDeviceTypes] = useState<DeviceType[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const [newGroupName, setNewGroupName] = useState('Company A');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [newTypeName, setNewTypeName] = useState('server');
  const [newTypeIcon, setNewTypeIcon] = useState('🖥️');
  const [newUserName, setNewUserName] = useState('member');
  const [newUserPassword, setNewUserPassword] = useState('member123');
  const [newUserRole, setNewUserRole] = useState<Role>('member');
  const [newUserGroupIds, setNewUserGroupIds] = useState<string[]>([]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const isAdmin = auth?.user.role === 'admin';

  const nodeTypes = useMemo(() => ({ networkNode: NetworkNode }), []);

  const authFetch = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers ?? {});
    if (auth?.token) headers.set('Authorization', `Bearer ${auth.token}`);
    return fetch(url, { ...options, headers });
  }, [auth?.token]);

  const handleUnauthorized = useCallback(async (response: Response) => {
    if (response.status === 401) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      setAuth(null);
      setLoginError('Please sign in again.');
      setMessageText('');
      setDrawerOpen(false);
      setNotificationsOpen(false);
      setNodeModalOpen(false);
      return true;
    }
    return false;
  }, []);

  const loadGroups = useCallback(async () => {
    const endpoint = isAdmin ? `${API}/api/groups/overview` : `${API}/api/groups`;
    const response = await authFetch(endpoint);
    if (!response.ok) return;
    const data: Group[] = await response.json();
    setGroups(data);
    setNewUserGroupIds((current) => current.length || !data.length ? current : [data[0].id]);
  }, [authFetch, isAdmin]);

  const loadDeviceTypes = useCallback(async () => {
    const response = await authFetch(`${API}/api/device-types`);
    if (!response.ok) return;
    setDeviceTypes(await response.json());
  }, [authFetch]);

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;
    const response = await authFetch(`${API}/api/users`);
    if (!response.ok) return;
    setUsers(await response.json());
  }, [authFetch, isAdmin]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setLoginError('');
    setMessageText('');
    const response = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUsername, password: loginPassword }),
    });
    if (!response.ok) {
      setLoginError(await response.text());
      return;
    }
    const data: AuthState = await response.json();
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data));
    setAuth(data);
  }

  async function logout() {
    if (auth?.token) {
      await authFetch(`${API}/api/auth/logout`, { method: 'POST' }).catch(() => undefined);
    }
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    setAuth(null);
  }

  const loadMap = useCallback(async (mapId: string) => {
    const response = await authFetch(`${API}/api/maps/${mapId}`);
    if (await handleUnauthorized(response)) return;
    if (!response.ok) throw new Error(await response.text());
    const data: MapResponse = await response.json();
    setCurrentMapId(data.id);
    setMapName(data.name);
    setBreadcrumbs(data.breadcrumbs);
    setNodes(data.nodes);
    setEdges(data.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setContextPopover(null);
    setHistory(null);
  }, [authFetch, handleUnauthorized, setEdges, setNodes]);

  const refreshStatusesOnly = useCallback(async () => {
    if (!auth?.token) return;
    const response = await authFetch(`${API}/api/maps/${currentMapId}`);
    if (await handleUnauthorized(response)) return;
    if (!response.ok) return;
    const data: MapResponse = await response.json();
    const freshByNodeId = new Map(data.nodes.map((node) => [node.id, node.data]));

    // Important: do not update mapName, breadcrumbs, edges, labels, groups or device metadata here.
    // This function runs in the background, so it must not reset sidebar inputs or modal forms.
    setNodes((currentNodes) => currentNodes.map((node) => {
      const freshData = freshByNodeId.get(node.id);
      if (!freshData) return node;
      return {
        ...node,
        data: {
          ...node.data,
          status: freshData.status,
          ownStatus: freshData.ownStatus,
          latencyMs: freshData.latencyMs,
          lastCheckedAt: freshData.lastCheckedAt,
        },
      };
    }));
  }, [auth?.token, authFetch, currentMapId, handleUnauthorized, setNodes]);

  const loadHistory = useCallback(async (nodeId: string) => {
    const response = await authFetch(`${API}/api/nodes/${nodeId}/history?limit=80`);
    if (!response.ok) return;
    const data: HistoryResponse = await response.json();
    setHistory(data);
  }, [authFetch]);


  const runSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!auth?.token || trimmed.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    try {
      const response = await authFetch(`${API}/api/search/nodes?q=${encodeURIComponent(trimmed)}&limit=80`);
      if (!response.ok) return;
      const data: SearchResult[] = await response.json();
      setSearchResults(data);
    } finally {
      setSearchLoading(false);
    }
  }, [auth?.token, authFetch]);

  async function openSearchResult(result: SearchResult) {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    await loadMap(result.mapId);
    setSelectedNodeId(result.nodeId);
    setSelectedEdgeId(null);
    setContextPopover(null);
    setNodeModalOpen(false);
    loadHistory(result.nodeId).catch(() => undefined);
  }

  const loadNotifications = useCallback(async (query = '', silent = false) => {
    if (!auth?.token) return;
    if (!silent) setNotificationLoading(true);
    try {
      const response = await authFetch(`${API}/api/notifications?q=${encodeURIComponent(query.trim())}&limit=120`);
      if (await handleUnauthorized(response)) return;
      if (!response.ok) return;
      const data: NotificationsResponse = await response.json();
      setNotifications(data.items);
      setNotificationTotal(data.total);
    } finally {
      if (!silent) setNotificationLoading(false);
    }
  }, [auth?.token, authFetch, handleUnauthorized]);

  async function deleteNotification(id: number) {
    askConfirmation({
      title: 'Delete notification?',
      message: 'This notification will be removed from the list.',
      confirmLabel: 'Yes, delete',
      danger: true,
      onConfirm: async () => {
        const response = await authFetch(`${API}/api/notifications/${id}`, { method: 'DELETE' });
        if (!response.ok) {
          setMessageText(await response.text());
          return;
        }
        await loadNotifications(notificationSearch);
      },
    });
  }

  async function deleteAllNotifications() {
    askConfirmation({
      title: 'Delete all notifications?',
      message: 'All notification records will be removed. This does not delete devices or status timeline.',
      confirmLabel: 'Yes, delete all',
      danger: true,
      onConfirm: async () => {
        const response = await authFetch(`${API}/api/notifications`, { method: 'DELETE' });
        if (!response.ok) {
          setMessageText(await response.text());
          return;
        }
        await loadNotifications(notificationSearch);
      },
    });
  }

  async function openNotification(item: NotificationItem) {
    if (!item.mapId) return;
    setNotificationsOpen(false);
    await loadMap(item.mapId);
    setSelectedNodeId(item.nodeId);
    setSelectedEdgeId(null);
    setContextPopover(null);
    setNodeModalOpen(true);
    loadHistory(item.nodeId).catch(() => undefined);
  }

  function askConfirmation(request: ConfirmRequest) {
    setConfirmRequest(request);
  }

  async function confirmYes() {
    const request = confirmRequest;
    setConfirmRequest(null);
    await request?.onConfirm();
  }

  function requestOpenChildMap(node: AppNode) {
    const childMapId = node.data.childMapId;
    if (!childMapId) return;
    askConfirmation({
      title: 'Open child map?',
      message: `Open the child folder/map for "${node.data.label}"?`,
      confirmLabel: 'Yes, open',
      onConfirm: async () => {
        setNodeModalOpen(false);
        setDrawerOpen(false);
        setContextPopover(null);
        await loadMap(childMapId);
      },
    });
  }

  async function changeOwnPassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordMessage('');
    if (newPassword !== confirmPassword) {
      setPasswordMessage('New passwords do not match.');
      return;
    }
    const response = await authFetch(`${API}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    if (!response.ok) {
      setPasswordMessage(await response.text());
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordMessage('Password changed.');
  }

  useEffect(() => {
    if (!auth?.token) return;
    Promise.all([loadGroups(), loadDeviceTypes()]).catch(() => undefined);
    loadMap('root').catch((err) => setMessageText(String(err)));
    loadNotifications('').catch(() => undefined);
  }, [auth?.token, loadMap, loadGroups, loadDeviceTypes, loadNotifications]);

  useEffect(() => {
    if (drawerOpen) {
      loadGroups().catch(() => undefined);
      loadDeviceTypes().catch(() => undefined);
      loadUsers().catch(() => undefined);
    }
  }, [drawerOpen, loadGroups, loadDeviceTypes, loadUsers]);

  useEffect(() => {
    if (!auth?.token) return;
    const interval = window.setInterval(() => {
      refreshStatusesOnly().catch(() => undefined);
      loadNotifications(notificationsOpen ? notificationSearch : '', true).catch(() => undefined);
      if (nodeModalOpen && selectedNodeId) loadHistory(selectedNodeId).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [auth?.token, refreshStatusesOnly, selectedNodeId, nodeModalOpen, loadHistory, loadNotifications, notificationsOpen, notificationSearch]);

  useEffect(() => {
    if (!auth?.token) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/status?token=${encodeURIComponent(auth.token)}`);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'node_status_changed') {
        setNodes((currentNodes) => currentNodes.map((node) => {
          if (node.id !== message.nodeId) return node;
          return {
            ...node,
            data: {
              ...node.data,
              status: message.status,
              ownStatus: message.status,
              latencyMs: message.latencyMs,
              lastCheckedAt: message.lastCheckedAt,
              monitorEnabled: true,
            },
          };
        }));
        if (selectedNodeId === message.nodeId) {
          loadHistory(message.nodeId).catch(() => undefined);
        }
        loadNotifications(notificationsOpen ? notificationSearch : '', true).catch(() => undefined);
      }
    };
    ws.onopen = () => ws.send('hello');
    return () => ws.close();
  }, [auth?.token, loadHistory, selectedNodeId, setNodes, loadNotifications, notificationsOpen, notificationSearch]);

  useEffect(() => {
    if (selectedNodeId) {
      loadHistory(selectedNodeId).catch(() => undefined);
    } else {
      setHistory(null);
    }
  }, [selectedNodeId, loadHistory]);


  useEffect(() => {
    if (!auth?.token) return;
    const handle = window.setTimeout(() => {
      runSearch(searchQuery).catch(() => undefined);
    }, 220);
    return () => window.clearTimeout(handle);
  }, [auth?.token, searchQuery, runSearch]);

  useEffect(() => {
    if (!auth?.token || !notificationsOpen) return;
    const handle = window.setTimeout(() => {
      loadNotifications(notificationSearch).catch(() => undefined);
    }, 220);
    return () => window.clearTimeout(handle);
  }, [auth?.token, notificationsOpen, notificationSearch, loadNotifications]);

  async function createNode() {
    if (!isAdmin) return;
    const typeId = deviceTypes[0]?.id ?? 'device';
    const groupIds = groups[0]?.id ? [groups[0].id] : [];
    const response = await authFetch(`${API}/api/maps/${currentMapId}/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New Device', type: typeId, x: 240, y: 160, group_ids: groupIds }),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    const node: AppNode = await response.json();
    setNodes((currentNodes) => [...currentNodes, node]);
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setDrawerOpen(false);
    setNodeModalOpen(true);
    setContextPopover(null);
  }

  function selectedPopoverGroupIds() {
    return groups
      .filter((group) => (document.getElementById(`node-group-${group.id}`) as HTMLInputElement | null)?.checked)
      .map((group) => group.id);
  }

  async function saveSelectedNode() {
    if (!selectedNode || !isAdmin) return;
    const label = (document.getElementById('node-label') as HTMLInputElement).value;
    const deviceType = (document.getElementById('node-type') as HTMLSelectElement).value;
    const ip = (document.getElementById('node-ip') as HTMLInputElement).value;
    const monitorEnabled = (document.getElementById('node-monitor') as HTMLInputElement).checked;
    const groupIds = selectedPopoverGroupIds();
    const response = await authFetch(`${API}/api/nodes/${selectedNode.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, type: deviceType, ip, monitor_enabled: monitorEnabled, group_ids: groupIds }),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    const updated: AppNode = await response.json();
    setNodes((currentNodes) => currentNodes.map((node) => node.id === updated.id ? updated : node));
  }

  async function deleteSelectedNode() {
    if (!selectedNode || !isAdmin) return;
    const nodeToDelete = selectedNode;
    askConfirmation({
      title: 'Delete device?',
      message: `Delete "${nodeToDelete.data.label}" and its connections from this map?`,
      confirmLabel: 'Yes, delete device',
      danger: true,
      onConfirm: async () => {
        const response = await authFetch(`${API}/api/nodes/${nodeToDelete.id}`, { method: 'DELETE' });
        if (!response.ok) {
          setMessageText(await response.text());
          return;
        }
        setNodes((currentNodes) => currentNodes.filter((node) => node.id !== nodeToDelete.id));
        setEdges((currentEdges) => currentEdges.filter((edge) => edge.source !== nodeToDelete.id && edge.target !== nodeToDelete.id));
        setSelectedNodeId(null);
        setNodeModalOpen(false);
        setContextPopover(null);
      },
    });
  }

  async function deleteSelectedEdge() {
    if (!selectedEdge || !isAdmin) return;
    const edgeToDelete = selectedEdge;
    askConfirmation({
      title: 'Delete connection?',
      message: `Delete connection ${edgeToDelete.source} → ${edgeToDelete.target}?`,
      confirmLabel: 'Yes, delete connection',
      danger: true,
      onConfirm: async () => {
        const response = await authFetch(`${API}/api/edges/${edgeToDelete.id}`, { method: 'DELETE' });
        if (!response.ok) {
          setMessageText(await response.text());
          return;
        }
        setEdges((currentEdges) => currentEdges.filter((edge) => edge.id !== edgeToDelete.id));
        setSelectedEdgeId(null);
        setContextPopover(null);
      },
    });
  }

  async function createChildMap() {
    if (!selectedNode || !isAdmin) return;
    const nodeForChild = selectedNode;
    askConfirmation({
      title: 'Create child map?',
      message: `Create and open a child folder/map for "${nodeForChild.data.label}"?`,
      confirmLabel: 'Yes, create',
      onConfirm: async () => {
        const response = await authFetch(`${API}/api/nodes/${nodeForChild.id}/child-map`, { method: 'POST' });
        if (!response.ok) {
          setMessageText(await response.text());
          return;
        }
        const data = await response.json();
        setDrawerOpen(false);
        setNodeModalOpen(false);
        setContextPopover(null);
        await loadMap(data.childMapId);
      },
    });
  }

  async function pingNow() {
    if (!selectedNode || !isAdmin) return;
    const response = await authFetch(`${API}/api/nodes/${selectedNode.id}/ping`, { method: 'POST' });
    const text = await response.text();
    setMessageText(text);
    await refreshStatusesOnly();
    await loadHistory(selectedNode.id);
  }

  const onConnect = useCallback(async (connection: Connection) => {
    if (!isAdmin || !connection.source || !connection.target) return;
    const response = await authFetch(`${API}/api/maps/${currentMapId}/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: connection.source, target: connection.target }),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    const created: Edge = await response.json();
    setEdges((currentEdges) => addEdge(created, currentEdges));
  }, [authFetch, currentMapId, isAdmin, setEdges]);

  const onNodeDragStop = useCallback(async (_event: unknown, node: AppNode) => {
    if (!isAdmin) return;
    await authFetch(`${API}/api/nodes/${node.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: node.position.x, y: node.position.y }),
    });
  }, [authFetch, isAdmin]);

  const onNodeDoubleClick = useCallback((event: React.MouseEvent, node: AppNode) => {
    event.stopPropagation();
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setDrawerOpen(false);
    setContextPopover(null);
    setNodeModalOpen(true);
    loadHistory(node.id).catch(() => undefined);
  }, [loadHistory]);

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.stopPropagation();
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
    setDrawerOpen(false);
    setContextPopover({ kind: 'edge', id: edge.id, x: event.clientX + 12, y: event.clientY + 12 });
  }, []);

  function onNodeClick(event: React.MouseEvent, node: AppNode) {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    if ((event.ctrlKey || event.metaKey) && node.data.childMapId) {
      event.stopPropagation();
      setDrawerOpen(false);
      setContextPopover(null);
      requestOpenChildMap(node);
    }
  }

  async function saveMapName() {
    if (!isAdmin) return;
    const response = await authFetch(`${API}/api/maps/${currentMapId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: mapName }),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    setBreadcrumbs((items) => items.map((item) => item.id === currentMapId ? { ...item, name: mapName } : item));
  }

  async function createGroup() {
    if (!isAdmin) return;
    const response = await authFetch(`${API}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newGroupName, description: newGroupDescription }),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    setNewGroupName('');
    setNewGroupDescription('');
    await loadGroups();
  }

  async function createDeviceType() {
    if (!isAdmin) return;
    const response = await authFetch(`${API}/api/device-types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newTypeName, icon: newTypeIcon }),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    setNewTypeName('');
    setNewTypeIcon('📦');
    await loadDeviceTypes();
  }

  function toggleId(list: string[], id: string) {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  async function createUser() {
    if (!isAdmin) return;
    const response = await authFetch(`${API}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUserName, password: newUserPassword, role: newUserRole, group_ids: newUserGroupIds }),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    setNewUserName('');
    setNewUserPassword('');
    await loadUsers();
  }

  async function patchUser(user: User, patch: Record<string, unknown>) {
    if (!isAdmin) return;
    const response = await authFetch(`${API}/api/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      setMessageText(await response.text());
      return;
    }
    await loadUsers();
  }

  if (!auth) {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={login}>
          <div className="logo big">WM</div>
          <h1>Whiracle WhirMap</h1>
          <p className="muted">Login to view network status and topology.</p>
          <label>Username</label>
          <input value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} autoFocus />
          <label>Password</label>
          <input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} />
          <button type="submit">Login</button>
          {loginError && <pre className="login-error">{loginError}</pre>}
          <p className="muted helper">Default first-run admin: <strong>admin</strong> / <strong>admin123</strong></p>
        </form>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="app-shell">
        <main className="canvas">
          <div className="map-topbar">
            <div className="left-action-stack">
              <button className="menu-button" onClick={() => setDrawerOpen(true)}>☰ Menu</button>
              <button className="notification-button" onClick={() => { setNotificationsOpen((open) => !open); loadNotifications(notificationSearch).catch(() => undefined); }}>
                🔔 Notifications
                {notificationTotal > 0 && <span className="notification-count">{notificationTotal}</span>}
              </button>
            </div>
            <div className="map-title-block">
              <strong>{mapName || 'Whiracle WhirMap'}</strong>
              <span className={`role-badge role-${auth.user.role}`}>{auth.user.role}</span>
              <div className="breadcrumbs compact">
                {breadcrumbs.map((crumb, index) => (
                  <React.Fragment key={crumb.id}>
                    {index > 0 && <span>/</span>}
                    <button className="crumb" onClick={() => loadMap(crumb.id)}>{crumb.name}</button>
                  </React.Fragment>
                ))}
              </div>
            </div>

            <div className="global-search">
              <span className="search-icon">⌕</span>
              <input
                value={searchQuery}
                onFocus={() => setSearchOpen(true)}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchOpen(true);
                }}
                placeholder="Search host, IP, group, folder..."
              />
              {searchQuery && <button className="search-clear" onClick={() => { setSearchQuery(''); setSearchResults([]); }}>×</button>}
              {searchOpen && searchQuery.trim().length >= 2 && (
                <div className="search-results">
                  <div className="search-results-head">
                    <span>{searchLoading ? 'Searching...' : `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`}</span>
                    <button className="mini-button" onClick={() => setSearchOpen(false)}>close</button>
                  </div>
                  {searchResults.length === 0 && !searchLoading && <p className="muted search-empty">No matching hosts.</p>}
                  {searchResults.map((result) => (
                    <button className="search-result-row" key={result.nodeId} onClick={() => openSearchResult(result)}>
                      <span className={`search-status status-dot-${result.status}`} />
                      <span className="search-result-main">
                        <strong>{result.deviceIcon} {result.label}</strong>
                        <span>{result.ip || 'no IP'} · {displayDeviceTypeName(result.deviceTypeName)} · {statusLabel(result.status)}</span>
                        <em>{result.mapPath}</em>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {isAdmin && <button className="quick-add" onClick={createNode}>+ Node</button>}
          </div>

          {notificationsOpen && (
            <section className="notifications-panel">
              <div className="notifications-header">
                <div>
                  <strong>Notifications</strong>
                  <p className="muted">Host status events</p>
                </div>
                <button className="icon-button" onClick={() => setNotificationsOpen(false)}>×</button>
              </div>
              <div className="notifications-tools">
                <input
                  value={notificationSearch}
                  onChange={(event) => setNotificationSearch(event.target.value)}
                  placeholder="Search notifications, IP, device, folder..."
                />
                <button className="secondary" onClick={() => loadNotifications(notificationSearch)}>Refresh</button>
                {notifications.length > 0 && <button className="danger" onClick={deleteAllNotifications}>Delete all</button>}
              </div>
              <div className="notifications-list">
                {notificationLoading && <p className="muted">Loading...</p>}
                {!notificationLoading && notifications.length === 0 && <p className="muted">No notifications yet.</p>}
                {notifications.map((item) => (
                  <div className={`notification-card notification-${item.status}`} key={item.id}>
                    <button className="notification-main" onClick={() => openNotification(item)}>
                      <span className={`notification-dot status-dot-${item.status}`} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.nodeIp || 'no IP'} · {item.mapPath || 'unknown folder'}</small>
                        <em>{formatDate(item.createdAt)}</em>
                      </span>
                    </button>
                    <button className="mini-button" onClick={() => deleteNotification(item.id)}>delete</button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={isAdmin ? onNodesChange : undefined}
            onEdgesChange={isAdmin ? onEdgesChange : undefined}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => { if (!nodeModalOpen) setSelectedNodeId(null); setSelectedEdgeId(null); setContextPopover(null); }}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={onNodeDoubleClick}
            nodeTypes={nodeTypes}
            nodesDraggable={isAdmin}
            nodesConnectable={isAdmin}
            edgesFocusable={isAdmin}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>

          {nodeModalOpen && selectedNode && (
            <div className="modal-backdrop" onClick={() => setNodeModalOpen(false)}>
              <section className="node-modal" onClick={(event) => event.stopPropagation()}>
                <div className="node-modal-header">
                  <div className="node-modal-title">
                    <span className={`node-modal-status status-dot-${selectedNode.data.status}`} />
                    <div>
                      <h2>{selectedNode.data.deviceIcon} {selectedNode.data.label}</h2>
                      <p className="muted">{displayDeviceTypeName(selectedNode.data.deviceTypeName)} · {statusLabel(selectedNode.data.status)} · {selectedNode.data.ip || 'no IP'}</p>
                    </div>
                  </div>
                  <button className="icon-button" onClick={() => setNodeModalOpen(false)}>×</button>
                </div>

                <div className="node-modal-grid">
                  <div className="node-modal-main">
                    <div className="modal-section">
                      <div className="section-heading">Device details</div>
                      <div className="form-grid two-columns">
                        <label>Label</label>
                        <input id="node-label" defaultValue={selectedNode.data.label} key={`label-modal-${selectedNode.id}`} disabled={!isAdmin} />

                        <label>Type</label>
                        <select id="node-type" defaultValue={selectedNode.data.deviceType} key={`type-modal-${selectedNode.id}`} disabled={!isAdmin}>
                          {deviceTypes.map((item) => <option key={item.id} value={item.id}>{item.icon} {displayDeviceTypeName(item.name)}</option>)}
                        </select>

                        <label>IP / hostname</label>
                        <input id="node-ip" defaultValue={selectedNode.data.ip ?? ''} key={`ip-modal-${selectedNode.id}`} placeholder="8.8.8.8" disabled={!isAdmin} />

                        <label className="checkbox-row modal-monitor-row">
                          <input id="node-monitor" type="checkbox" defaultChecked={selectedNode.data.monitorEnabled} key={`monitor-modal-${selectedNode.id}`} disabled={!isAdmin} />
                          Ping this node
                        </label>
                      </div>
                    </div>

                    <div className="modal-section">
                      <div className="section-heading">Groups / visibility</div>
                      <p className="muted helper">Members can see this device only when they share at least one selected group.</p>
                      <div className="checkbox-list selectable-list modal-group-list">
                        {groups.map((group) => (
                          <label className={`checkbox-row selectable-row ${selectedNode.data.groupIds.includes(group.id) ? 'checked' : ''}`} key={group.id}>
                            <input id={`node-group-${group.id}`} type="checkbox" defaultChecked={selectedNode.data.groupIds.includes(group.id)} disabled={!isAdmin} />
                            <span>
                              <strong>{group.name}</strong>
                              {group.description && <small>{group.description}</small>}
                            </span>
                          </label>
                        ))}
                        {groups.length === 0 && <p className="muted">No groups yet.</p>}
                      </div>
                    </div>

                    <div className="modal-section compact-info-grid">
                      <div>
                        <span className="entity-label">Current status</span>
                        <strong>{statusLabel(selectedNode.data.status)}</strong>
                      </div>
                      <div>
                        <span className="entity-label">Latency</span>
                        <strong>{selectedNode.data.latencyMs ?? 'n/a'} ms</strong>
                      </div>
                      <div>
                        <span className="entity-label">Last check</span>
                        <strong>{formatDate(selectedNode.data.lastCheckedAt)}</strong>
                      </div>
                      <div>
                        <span className="entity-label">Current folder</span>
                        <strong>{breadcrumbs.map((crumb) => crumb.name).join(' / ') || mapName}</strong>
                      </div>
                    </div>
                  </div>

                  <aside className="node-modal-side">
                    <div className="modal-section timeline-section">
                      <div className="panel-title row-title">
                        <span>Status timeline</span>
                        <button className="mini-button" onClick={() => loadHistory(selectedNode.id)}>Refresh</button>
                      </div>
                      {!history && <p className="muted">No history loaded yet.</p>}
                      {history && (
                        <>
                          <div className="history-summary compact-history">
                            <span>Down incidents: <strong>{history.summary.downEvents}</strong></span>
                            <span>Total downtime: <strong>{formatDuration(history.summary.totalDowntimeSeconds)}</strong></span>
                          </div>
                          <div className="timeline modal-timeline">
                            {history.items.length === 0 && <p className="muted">No state changes yet.</p>}
                            {history.items.map((item) => (
                              <div className="timeline-row" key={item.id} title={`${item.status} · ${formatDate(item.startedAt)} → ${item.isOpen ? 'now' : formatDate(item.endedAt)} · ${item.source}`}>
                                <span className={`timeline-dot status-dot-${item.status}`} />
                                <div>
                                  <div className="timeline-head">
                                    <strong>{eventTitle(item)}</strong>
                                    {item.isOpen && <span className="open-badge">current</span>}
                                  </div>
                                  <div className="muted">{formatDate(item.startedAt)} → {item.isOpen ? 'now' : formatDate(item.endedAt)}</div>
                                  <div className="muted">Duration: {formatDuration(item.durationSeconds)}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </aside>
                </div>

                <div className="node-modal-actions">
                  {isAdmin && <button onClick={saveSelectedNode}>Save changes</button>}
                  {selectedNode.data.childMapId && <button className="secondary" onClick={() => requestOpenChildMap(selectedNode)}>Open child map</button>}
                  {isAdmin && !selectedNode.data.childMapId && <button className="secondary" onClick={createChildMap}>Create child map</button>}
                  {isAdmin && <button className="danger" onClick={deleteSelectedNode}>Delete device</button>}
                </div>
              </section>
            </div>
          )}

          {contextPopover?.kind === 'edge' && selectedEdge && contextPopover.id === selectedEdge.id && (
            <div
              className="edge-popover"
              style={popoverStyle(contextPopover.x, contextPopover.y, 260)}
            >
              <div className="popover-header">
                <div>
                  <strong>Connection</strong>
                  <div className="muted">{selectedEdge.source} → {selectedEdge.target}</div>
                </div>
                <button className="icon-button" onClick={() => setContextPopover(null)}>×</button>
              </div>
              {isAdmin ? <button className="danger" onClick={deleteSelectedEdge}>Delete edge</button> : <p className="muted">Read-only</p>}
            </div>
          )}

          {confirmRequest && (
            <div className="confirm-backdrop" onClick={() => setConfirmRequest(null)}>
              <section className={`confirm-dialog ${confirmRequest.danger ? 'danger-confirm' : ''}`} onClick={(event) => event.stopPropagation()}>
                <h3>{confirmRequest.title}</h3>
                <p>{confirmRequest.message}</p>
                <div className="confirm-actions">
                  <button className="secondary" autoFocus onClick={() => setConfirmRequest(null)}>No</button>
                  <button className={confirmRequest.danger ? 'danger' : ''} onClick={confirmYes}>{confirmRequest.confirmLabel ?? 'Yes'}</button>
                </div>
              </section>
            </div>
          )}
        </main>

        {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
        <aside className={`drawer ${drawerOpen ? 'open' : ''}`}>
          <div className="drawer-header">
            <div className="brand">
              <div className="logo">WM</div>
              <div>
                <h1>Whiracle WhirMap</h1>
                <p>{auth.user.username} · {auth.user.role}</p>
              </div>
            </div>
            <button className="icon-button" onClick={() => setDrawerOpen(false)}>×</button>
          </div>

          <AccordionSection id="map" title="Current map" active={activeSection} setActive={setActiveSection}>
            <input value={mapName} onChange={(event) => setMapName(event.target.value)} disabled={!isAdmin} />
            {isAdmin && <button onClick={saveMapName}>Save map name</button>}
            <div className="breadcrumbs">
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.id}>
                  {index > 0 && <span>/</span>}
                  <button className="crumb" onClick={() => loadMap(crumb.id)}>{crumb.name}</button>
                </React.Fragment>
              ))}
            </div>
          </AccordionSection>

          <AccordionSection id="account" title="Account" active={activeSection} setActive={setActiveSection}>
            <p className="muted helper">Logged in as <strong>{auth.user.username}</strong>. Change the first admin password here after first login.</p>
            <form className="form-grid" onSubmit={changeOwnPassword}>
              <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="current password" />
              <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="new password" />
              <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="confirm new password" />
              <button type="submit">Change password</button>
            </form>
            {passwordMessage && <p className="muted helper">{passwordMessage}</p>}
            <button className="secondary" onClick={logout}>Logout</button>
          </AccordionSection>

          {isAdmin && (
            <AccordionSection id="actions" title="Map actions" active={activeSection} setActive={setActiveSection}>
              <button onClick={createNode}>+ Add node</button>
              {selectedEdge && <button className="danger" onClick={deleteSelectedEdge}>Delete selected edge</button>}
              {!selectedEdge && <p className="muted helper">Drag from one node handle to another to create a line.</p>}
            </AccordionSection>
          )}

          {isAdmin && (
            <AccordionSection id="types" title="Device types" active={activeSection} setActive={setActiveSection}>
              <p className="muted helper">Default is only <strong>Device</strong>. Add your own types and icons here.</p>

              <div className="section-block">
                <div className="section-heading">Existing device types</div>
                <div className="type-grid">
                  {deviceTypes.map((item) => (
                    <div className="type-card" key={item.id}>
                      <span className="type-icon">{item.icon}</span>
                      <strong>{displayDeviceTypeName(item.name)}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="section-block">
                <div className="section-heading">Create new device type</div>
                <div className="form-grid">
                  <input value={newTypeName} onChange={(event) => setNewTypeName(event.target.value)} placeholder="type name" />
                  <div className="icon-picker">
                    {ICON_OPTIONS.map((icon) => (
                      <button key={icon} className={`icon-choice ${newTypeIcon === icon ? 'active' : ''}`} onClick={() => setNewTypeIcon(icon)}>{icon}</button>
                    ))}
                  </div>
                  <button onClick={createDeviceType}>Create device type</button>
                </div>
              </div>
            </AccordionSection>
          )}

          {isAdmin && (
            <AccordionSection id="groups" title="Groups" active={activeSection} setActive={setActiveSection}>
              <p className="muted helper">Groups control what members can see. A member sees devices that share at least one group.</p>

              <div className="section-block">
                <div className="section-heading">Existing groups</div>
                <div className="entity-list">
                  {groups.length === 0 && <p className="muted">No groups yet.</p>}
                  {groups.map((group) => (
                    <div className="entity-card group-card" key={group.id}>
                      <div className="entity-card-head">
                        <div>
                          <strong>{group.name}</strong>
                          <div className="muted">{group.description || 'no description'}</div>
                        </div>
                        <span className="count-pill">{group.deviceCount ?? group.devices?.length ?? 0} devices</span>
                      </div>

                      <div className="entity-subsection">
                        <span className="entity-label">Members</span>
                        <div className="chip-list compact-chips">
                          {(group.users ?? []).length === 0 && <span className="muted">No members</span>}
                          {(group.users ?? []).map((user) => (
                            <span className={`chip ${user.isActive ? '' : 'muted-chip'}`} key={user.id}>{user.username} · {user.role}</span>
                          ))}
                        </div>
                      </div>

                      <div className="entity-subsection">
                        <span className="entity-label">Devices</span>
                        <div className="mini-device-list">
                          {(group.devices ?? []).length === 0 && <span className="muted">No devices assigned</span>}
                          {(group.devices ?? []).map((device) => (
                            <span className={`mini-device status-text-${device.status}`} key={device.id}>
                              {device.label}{device.ip ? ` · ${device.ip}` : ''}
                            </span>
                          ))}
                          {(group.deviceCount ?? 0) > (group.devices?.length ?? 0) && <span className="muted">+{(group.deviceCount ?? 0) - (group.devices?.length ?? 0)} more</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="section-block">
                <div className="section-heading">Create new group</div>
                <div className="form-grid">
                  <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="group name" />
                  <input value={newGroupDescription} onChange={(event) => setNewGroupDescription(event.target.value)} placeholder="description" />
                  <button onClick={createGroup}>Create group</button>
                </div>
              </div>
            </AccordionSection>
          )}

          {isAdmin && (
            <AccordionSection id="members" title="Members" active={activeSection} setActive={setActiveSection}>
              <div className="section-block">
                <div className="section-heading">Existing members</div>
                <div className="entity-list">
                  {users.map((user) => (
                    <div className="entity-card user-row vertical" key={user.id}>
                      <div className="user-row-top">
                        <div>
                          <strong>{user.username}</strong>
                          <div className="muted">{user.role} · {user.isActive ? 'active' : 'disabled'}</div>
                        </div>
                        <div className="user-actions">
                          <button className="mini-button" onClick={() => patchUser(user, { role: user.role === 'admin' ? 'member' : 'admin' })}>role</button>
                          <button className="mini-button" onClick={() => patchUser(user, { is_active: !user.isActive })}>{user.isActive ? 'disable' : 'enable'}</button>
                        </div>
                      </div>
                      <div className="entity-subsection">
                        <span className="entity-label">Visible groups</span>
                        <div className="checkbox-list inline-groups selectable-list">
                          {groups.map((group) => (
                            <label className={`checkbox-row selectable-row ${user.groupIds.includes(group.id) ? 'checked' : ''}`} key={group.id}>
                              <input type="checkbox" checked={user.groupIds.includes(group.id)} onChange={() => patchUser(user, { group_ids: toggleId(user.groupIds, group.id) })} />
                              {group.name}
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="section-block">
                <div className="section-heading">Create new member</div>
                <div className="form-grid">
                  <input value={newUserName} onChange={(event) => setNewUserName(event.target.value)} placeholder="username" />
                  <input value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="password" />
                  <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as Role)}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  <div className="entity-label">Initial groups</div>
                  <div className="checkbox-list selectable-list">
                    {groups.map((group) => (
                      <label className={`checkbox-row selectable-row ${newUserGroupIds.includes(group.id) ? 'checked' : ''}`} key={group.id}>
                        <input type="checkbox" checked={newUserGroupIds.includes(group.id)} onChange={() => setNewUserGroupIds((current) => toggleId(current, group.id))} />
                        {group.name}
                      </label>
                    ))}
                  </div>
                  <button onClick={createUser}>Create member</button>
                </div>
              </div>
            </AccordionSection>
          )}

          <AccordionSection id="help" title="Map usage" active={activeSection} setActive={setActiveSection}>
            <p className="muted helper">Double-click a node to open device management. Use Open child map from the device window or hold Ctrl and click a node to enter its child map. Members are read-only and only see devices from their groups.</p>
          </AccordionSection>

          {messageText && (
            <div className="system-message"><pre>{messageText}</pre></div>
          )}
        </aside>
      </div>
    </ReactFlowProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
