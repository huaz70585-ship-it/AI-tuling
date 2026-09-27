import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '../stores/user'

const Home = () => import('../views/Home.vue')
const Chat = () => import('../views/Chat.vue')
const TripList = () => import('../views/TripList.vue')
const Trip = () => import('../views/Trip.vue')
const Message = () => import('../views/Message.vue')
const Profile = () => import('../views/profile.vue')
const Login = () => import('../views/Login.vue')

// 需要登录才能访问的路由
const AUTH_ROUTES = ['chat', 'trip', 'trip-detail', 'message', 'profile']

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/chat', name: 'chat', component: Chat },
    // /trip 是行程列表（L1 落地页），/trip/:id 才是某一次行程的详情（L2）
    { path: '/trip', name: 'trip', component: TripList },
    { path: '/trip/:id', name: 'trip-detail', component: Trip },
    { path: '/message', name: 'message', component: Message },
    { path: '/profile', name: 'profile', component: Profile },
    { path: '/login', name: 'login', component: Login },
  ],

  /**
   * 每次进入页面都回到顶部。
   *
   * 不配这个的话，窗口的滚动位置会一直留着：从对话页返回首页时，首页会停在
   * 上次滚到的地方（点底栏「首页」也一样，因为没人重置过窗口滚动）。
   *
   * 刻意【不做】savedPosition 恢复 —— Vue Router 文档里常见的写法是
   * `savedPosition || { top: 0 }`，那会让「按浏览器返回键时恢复原位置」生效。
   * 本产品是标签页式结构（底栏切来切去、详情页返回列表），每次进来从头看更
   * 符合预期，所以这里无条件回顶部。
   *
   * 注意：只对「窗口自身滚动」的页面有意义。对话页是内部容器滚动
   * （.chat 固定 100vh + 消息区自己 overflow-y），它自己管滚动，不受这里影响。
   */
  scrollBehavior: () => ({ top: 0 }),
})

// 全局前置守卫
router.beforeEach((to) => {
  const userStore = useUserStore()

  // 已登录 → 禁止进登录页，踢回首页
  if (to.name === 'login' && userStore.isLoggedIn) {
    return { name: 'home' }
  }

  // 未登录 → 访问需登录的路由，踢去登录页
  if (AUTH_ROUTES.includes(to.name as string) && !userStore.isLoggedIn) {
    return { name: 'login' }
  }
})

export default router
