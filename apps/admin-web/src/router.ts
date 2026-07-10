import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import CustomersView from './views/CustomersView.vue';
import NodesView from './views/NodesView.vue';
import FinanceView from './views/FinanceView.vue';
import CardsView from './views/CardsView.vue';
import SettingsView from './views/SettingsView.vue';

export const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    { path: '/', component: DashboardView },
    { path: '/customers', component: CustomersView },
    { path: '/nodes', component: NodesView },
    { path: '/finance', component: FinanceView },
    { path: '/cards', component: CardsView },
    { path: '/settings', component: SettingsView }
  ]
});
