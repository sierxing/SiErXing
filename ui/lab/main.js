import { createApp } from 'vue';
import App from './App.vue';
import { installHost } from '../sdk/host.js';

installHost();
createApp(App).mount('#uilab');
