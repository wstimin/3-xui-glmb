import { createRouter, createWebHistory } from 'vue-router';
import HomeView from './views/HomeView.vue';
import NodesView from './views/NodesView.vue';
import FinanceView from './views/FinanceView.vue';
import ProfileView from './views/ProfileView.vue';
import PaymentResultView from './views/PaymentResultView.vue';

export const router = createRouter({
  history: createWebHistory('/'),
  routes: [
    { path: '/', component: HomeView },
    { path: '/nodes', component: NodesView },
    { path: '/finance', component: FinanceView },
    { path: '/profile', component: ProfileView },
    { path: '/payment/result', component: PaymentResultView }
  ]
});
