import { Globe } from 'lucide-react';
import type { UIModule } from '../types';
import { SitesPage } from './SitesPage';
import { SitePublishCard } from './PublishCard';

/**
 * Websites:
 *  #/m/sites            the sites the bots published (open, copy link, stop, publish again, delete)
 *  approval card        site_publish: folder, files, size, who can open it, expiry
 */
const mod: UIModule = {
  id: 'sites',
  label: 'Websites',
  pages: [{ path: '', title: 'Websites', icon: Globe, nav: true, component: SitesPage }],
  approvalRenderers: { site_publish: SitePublishCard },
};

export default mod;
