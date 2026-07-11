import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import CustomersView from './views/CustomersView.vue';
import NodesView from './views/NodesView.vue';
import XuiServersView from './views/XuiServersView.vue';
import SocksNodesView from './views/SocksNodesView.vue';
import SyncLogsView from './views/SyncLogsView.vue';
import FinanceView from './views/FinanceView.vue';
import CardsView from './views/CardsView.vue';
import PaymentsView from './views/PaymentsView.vue';
import SettingsView from './views/SettingsView.vue';

export const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    { path: '/', component: DashboardView },
    { path: '/customers', component: CustomersView },
    { path: '/xui-servers', component: XuiServersView },
    { path: '/nodes', component: NodesView },
    { path: '/socks-nodes', component: SocksNodesView },
    { path: '/sync-logs', component: SyncLogsView },
    { path: '/finance', component: FinanceView },
    { path: '/cards', component: CardsView },
    { path: '/payments', component: PaymentsView },
    { path: '/settings', component: SettingsView }
  ]
});
