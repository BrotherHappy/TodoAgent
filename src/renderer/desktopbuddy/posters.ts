// Captures of the five bundled original models, not replacement animations.
// Same sample-data terms as assets/desktopbuddy/live2d-presets apply.
import wanko from '../../assets/desktopbuddy-posters/wanko-live2d.png';
import hiyori from '../../assets/desktopbuddy-posters/hiyori-live2d.png';
import rice from '../../assets/desktopbuddy-posters/rice-live2d.png';
import mark from '../../assets/desktopbuddy-posters/mark-live2d.png';
import haru from '../../assets/desktopbuddy-posters/haru-live2d.png';

const posters: Record<string, string> = { 'wanko-live2d': wanko, 'hiyori-live2d': hiyori,
  'rice-live2d': rice, 'mark-live2d': mark, 'haru-live2d': haru };
export function buddyPoster(themeId: string) { return posters[themeId] ?? wanko; }
