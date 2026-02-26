const MENU_BTN_PROJECTS = 'Projects';
const MENU_BTN_SESSIONS = 'Sesiones';
const MENU_BTN_RESUME_LAST = 'Reanudar última';
const MENU_BTN_HIDE_KEYBOARD = 'Ocultar teclado';

function buildMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_BTN_PROJECTS }, { text: MENU_BTN_SESSIONS }],
      [{ text: MENU_BTN_RESUME_LAST }],
      [{ text: MENU_BTN_HIDE_KEYBOARD }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

module.exports = {
  buildMainMenuKeyboard,
  MENU_BTN_HIDE_KEYBOARD,
  MENU_BTN_PROJECTS,
  MENU_BTN_RESUME_LAST,
  MENU_BTN_SESSIONS,
};
