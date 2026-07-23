// ==========================================
// ESTADO Y CONFIGURACIÓN GLOBAL
// ==========================================
const AppData = {
    tasks: [],
    templates: [],
    config: {
        theme: 'auto',
        notifyBefore: 15,
        notifyExact: true,
        welcomeCompleted: false,
        lastResetDate: new Date().toDateString()
    }
};

let currentContextMenuTask = null;
let notificationInterval = null;

// ==========================================
// LOCAL STORAGE Y PERSISTENCIA
// ==========================================
function saveData() {
    localStorage.setItem('navajo_data', JSON.stringify(AppData));
}

function loadData() {
    const saved = localStorage.getItem('navajo_data');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            AppData.tasks = parsed.tasks || [];
            AppData.templates = parsed.templates || [];
            AppData.config = { ...AppData.config, ...parsed.config };
        } catch (e) {
            console.error("Error al leer datos locales");
        }
    }
}

// ==========================================
// INICIALIZACIÓN Y REINICIO DIARIO
// ==========================================
function initApp() {
    loadData();
    applyTheme(AppData.config.theme);
    
    if (!AppData.config.welcomeCompleted) {
        document.getElementById('welcome-screen').classList.remove('hidden');
        document.getElementById('main-screen').classList.add('hidden');
    } else {
        checkDailyReset();
        renderMain();
        requestNotificationPermission();
        startNotificationEngine();
    }
    
    setupEventListeners();
    setupServiceWorker();
}

function checkDailyReset() {
    const today = new Date().toDateString();
    if (AppData.config.lastResetDate !== today) {
        // Reiniciar tareas diarias y semanales
        AppData.tasks.forEach(task => {
            if ((task.type === 'daily' || task.type === 'custom') && task.completed) {
                task.completed = false;
            }
        });
        AppData.config.lastResetDate = today;
        saveData();
    }
}

// ==========================================
// RENDERIZADO DE INTERFAZ
// ==========================================
function renderMain() {
    renderSummary();
    renderTasks();
}

function renderSummary() {
    const today = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('summary-date').textContent = today.toLocaleDateString('es-ES', options);

    const isTodayTask = (t) => {
        if (t.type === 'once') return t.date === today.toISOString().split('T')[0];
        if (t.type === 'daily') return true;
        if (t.type === 'custom') return t.customDays.includes(today.getDay().toString());
        return false;
    };

    const todaysTasks = AppData.tasks.filter(isTodayTask);
    const pending = todaysTasks.filter(t => !t.completed).length;
    const completed = todaysTasks.filter(t => t.completed).length;
    const highPending = todaysTasks.filter(t => !t.completed && t.priority === 'high').length;
    const total = pending + completed;
    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

    document.getElementById('stat-pending').textContent = `${pending} pendientes`;
    document.getElementById('stat-completed').textContent = `${completed} completadas`;
    document.getElementById('stat-high-priority').textContent = highPending > 0 ? `${highPending} tareas de alta prioridad` : 'Sin tareas urgentes';
    
    document.getElementById('progress-bar-fill').style.width = `${pct}%`;
    document.getElementById('progress-text').textContent = `${pct}%`;
}

function renderTasks() {
    const list = document.getElementById('task-list');
    list.innerHTML = '';
    
    const todayStr = new Date().toISOString().split('T')[0];
    const currentDayOfWeek = new Date().getDay().toString();
    const nowTime = new Date().toTimeString().slice(0,5);

    // Filtrar tareas que tocan hoy o están atrasadas
    let activeTasks = AppData.tasks.filter(t => {
        if (t.completed) return true; // Mostramos las completadas al final
        if (t.type === 'once' && t.date < todayStr) return true; // Vencidas
        if (t.type === 'once' && t.date === todayStr) return true; // Hoy
        if (t.type === 'daily') return true;
        if (t.type === 'custom' && t.customDays.includes(currentDayOfWeek)) return true;
        return false;
    });

    // Ordenamiento: Pendientes primero (Prioridad > Hora) -> Completadas al final
    activeTasks.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        
        const prioMap = { high: 1, medium: 2, low: 3 };
        if (prioMap[a.priority] !== prioMap[b.priority]) return prioMap[a.priority] - prioMap[b.priority];
        
        return a.time.localeCompare(b.time);
    });

    activeTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = `task-item priority-${task.priority}`;
        li.dataset.id = task.id;
        
        // Determinar estado visual
        if (task.completed) {
            li.classList.add('status-completed');
        } else {
            // Chequear si es vencida o próxima
            const isToday = task.type !== 'once' || task.date === todayStr;
            if (isToday) {
                if (nowTime > task.time) li.classList.add('status-overdue');
                else {
                    const taskDate = new Date(`${todayStr}T${task.time}`);
                    const now = new Date();
                    const diffMins = (taskDate - now) / 60000;
                    if (diffMins > 0 && diffMins <= 30) li.classList.add('status-upcoming');
                }
            } else if (task.type === 'once' && task.date < todayStr) {
                li.classList.add('status-overdue');
            }
        }

        li.innerHTML = `
            <div class="task-header">
                <span class="task-title">${task.completed ? '✔️ ' : ''}${task.title}</span>
                <span class="task-time">${task.time}</span>
            </div>
            <div class="task-details">
                <p>${task.desc || 'Sin descripción'}</p>
                <p><small>Repetición: ${translateType(task.type)}</small></p>
            </div>
        `;
        
        // ==========================================
        // EVENTOS DE TÁCTIL, SWIPE Y MENÚ CONTEXTUAL
        // ==========================================
        let pressTimer;
        let startX = 0;
        let startY = 0;
        let currentX = 0;
        let isSwiping = false;

        // Desplegar detalles al hacer clic simple (solo si no fue un swipe)
        li.addEventListener('click', (e) => {
            if (!isSwiping) {
                li.classList.toggle('expanded');
            }
        });

        // INICIO DEL TOQUE
        li.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentX = startX;
            isSwiping = false;
            li.classList.add('swiping');

            // Mantener pulsado para abrir menú contextual
            pressTimer = setTimeout(() => {
                openContextMenu(e, task);
            }, 600);
        }, { passive: true });

        // MOVIMIENTO (ARRASTRE / SWIPE)
        li.addEventListener('touchmove', (e) => {
            currentX = e.touches[0].clientX;
            const currentY = e.touches[0].clientY;
            const diffX = currentX - startX;
            const diffY = currentY - startY;

            // Detectar si el gesto es predominantemente horizontal
            if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 10) {
                clearTimeout(pressTimer); // Cancelar menú contextual si desliza
                isSwiping = true;

                // Mover visualmente la tarjeta con transparencia progresiva
                li.style.transform = `translateX(${diffX}px)`;
                li.style.opacity = `${1 - Math.abs(diffX) / 300}`;
            }
        }, { passive: true });

        // FIN DEL TOQUE
        li.addEventListener('touchend', () => {
            clearTimeout(pressTimer);
            li.classList.remove('swiping');

            if (isSwiping) {
                const diffX = currentX - startX;
                const threshold = 100; // Píxeles necesarios para confirmar el gesto

                if (Math.abs(diffX) >= threshold) {
                    // Animación de salida completa hacia el lado correspondiente
                    li.style.transform = `translateX(${diffX > 0 ? 400 : -400}px)`;
                    li.style.opacity = '0';

                    // Cambiar el estado de la tarea tras la animación
                    setTimeout(() => {
                        toggleTaskState(task);
                    }, 200);
                } else {
                    // Restaurar posición si no alcanzó el umbral
                    li.style.transform = 'translateX(0)';
                    li.style.opacity = '1';
                }
            } else {
                // Restaurar en caso de toque simple
                li.style.transform = 'translateX(0)';
                li.style.opacity = '1';
            }
        });

        // Soporte de menú contextual para ratón en escritorio
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openContextMenu(e, task);
        });

        // Insertar el elemento en la lista
        list.appendChild(li); 
        
    }); // FIN DEL forEach
} // FIN DE renderTasks()

function translateType(type) {
    if(type==='once') return 'Una vez';
    if(type==='daily') return 'Todos los días';
    return 'Días específicos';
}

// ==========================================
// GESTIÓN DE TAREAS (CRUD)
// ==========================================
function saveTaskFromForm() {
    const id = document.getElementById('task-id').value;
    const title = document.getElementById('task-name').value.trim();
    if (!title) return alert("El nombre es obligatorio");
    
    const time = document.getElementById('task-time').value;
    if (!time) return alert("La hora es obligatoria");

    const type = document.getElementById('task-type').value;
    const date = document.getElementById('task-date').value;
    if (type === 'once' && !date) return alert("La fecha es obligatoria para tareas únicas");

    let customDays = [];
    if (type === 'custom') {
        document.querySelectorAll('#custom-days-container input:checked').forEach(cb => customDays.push(cb.value));
        if (customDays.length === 0) return alert("Selecciona al menos un día");
    }

    const newTask = {
        id: id || Date.now().toString(),
        title,
        desc: document.getElementById('task-desc').value,
        type,
        date: type === 'once' ? date : null,
        time,
        customDays,
        priority: document.getElementById('task-priority').value,
        completed: false,
        notified: false
    };

    if (id) {
        const idx = AppData.tasks.findIndex(t => t.id === id);
        if (idx !== -1) {
            // Mantener estado completado si se edita
            newTask.completed = AppData.tasks[idx].completed;
            AppData.tasks[idx] = newTask;
        }
    } else {
        AppData.tasks.push(newTask);
    }

    saveData();
    closeModal('task-modal');
    renderMain();
}

function toggleTaskState(task) {
    if (task.completed) {
        task.completed = false;
    } else {
        if (task.type === 'once') {
            // Tarea única se elimina al completar (animación omitida por simplicidad)
            AppData.tasks = AppData.tasks.filter(t => t.id !== task.id);
        } else {
            task.completed = true;
        }
    }
    saveData();
    renderMain();
}

function deleteTask(taskId) {
    if(confirm("¿Quieres eliminar esta tarea?")) {
        AppData.tasks = AppData.tasks.filter(t => t.id !== taskId);
        saveData();
        renderMain();
    }
}

function duplicateTask(task) {
    const newTask = { ...task, id: Date.now().toString(), completed: false };
    AppData.tasks.push(newTask);
    saveData();
    renderMain();
}

// ==========================================
// MENÚ CONTEXTUAL
// ==========================================
function openContextMenu(e, task) {
    currentContextMenuTask = task;
    const menu = document.getElementById('context-menu');
    menu.classList.remove('hidden');
    
    // Posicionamiento
    let x = e.clientX || (e.touches && e.touches[0].clientX);
    let y = e.clientY || (e.touches && e.touches[0].clientY);
    
    menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 250)}px`;
}

// ==========================================
// NOTIFICACIONES (CORREGIDO PARA ANDROID / PWA)
// ==========================================
function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }
}

function startNotificationEngine() {
    if (notificationInterval) clearInterval(notificationInterval);
    checkNotifications(); // Ejecución inicial inmediata
    notificationInterval = setInterval(checkNotifications, 30000); // Comprobar cada 30 segundos para mayor precisión
}

function checkNotifications() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    
    const now = new Date();
    
    // Obtener fecha LOCAL (evita el fallo de zona horaria de toISOString)
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    
    const currentDayOfWeek = now.getDay().toString();

    AppData.tasks.forEach(task => {
        if (task.completed) return;
        
        let shouldNotify = false;
        
        // Determinar si la tarea aplica para el día de hoy
        const isToday = (task.type === 'once' && task.date === todayStr) ||
                        (task.type === 'daily') ||
                        (task.type === 'custom' && task.customDays && task.customDays.includes(currentDayOfWeek));

        if (!isToday) return;

        // Calcular la diferencia exacta de minutos en hora local
        const [taskHours, taskMins] = task.time.split(':').map(Number);
        const taskDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), taskHours, taskMins);
        const diffMins = Math.round((taskDate - now) / 60000);

        const notifyBefore = parseInt(AppData.config.notifyBefore) || 0;
        
        if (AppData.config.notifyExact && diffMins === 0) shouldNotify = true;
        if (notifyBefore > 0 && diffMins === notifyBefore) shouldNotify = true;
        
        // DISPARAR NOTIFICACIÓN VÍA SERVICE WORKER
        if (shouldNotify && !task.notified) {
            const titulo = "NAVAJO - Recordatorio";
            const opciones = {
                body: `${task.title} a las ${task.time}`,
                icon: 'icons/icon-192.png',
                badge: 'icons/iconnoti.png',
                vibrate: [200, 100, 200]
            };

            // Método correcto para Android, PWA y Chrome
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.ready.then(reg => {
                    reg.showNotification(titulo, opciones);
                }).catch(() => {
                    new Notification(titulo, opciones); // Fallback para PC
                });
            } else {
                new Notification(titulo, opciones);
            }

            task.notified = true; // Prevenir múltiples alertas
            setTimeout(() => { task.notified = false; }, 65000);
        }
    });
}

function snoozeTask(task) {
    // Añade 15 mins a la hora actual para la tarea
    const now = new Date();
    now.setMinutes(now.getMinutes() + 15);
    task.time = now.toTimeString().slice(0,5);
    if(task.type === 'once') task.date = now.toISOString().split('T')[0];
    saveData();
    renderMain();
    alert("Posponiendo 15 minutos...");
}

// ==========================================
// UTILIDADES E INTERFAZ
// ==========================================
function applyTheme(theme) {
    if (theme === 'auto') {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.classList.toggle('dark-mode', prefersDark);
    } else {
        document.body.classList.toggle('dark-mode', theme === 'dark');
    }
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function openTaskForm(task = null) {
    document.getElementById('task-id').value = task ? task.id : '';
    document.getElementById('task-name').value = task ? task.title : '';
    document.getElementById('task-desc').value = task ? task.desc : '';
    document.getElementById('task-type').value = task ? task.type : 'once';
    document.getElementById('task-date').value = task && task.date ? task.date : new Date().toISOString().split('T')[0];
    document.getElementById('task-time').value = task ? task.time : '';
    document.getElementById('task-priority').value = task ? task.priority : 'medium';
    
    document.querySelectorAll('#custom-days-container input').forEach(cb => {
        cb.checked = task && task.customDays ? task.customDays.includes(cb.value) : false;
    });
    
    toggleTaskTypeFields();
    openModal('task-modal');
}

function toggleTaskTypeFields() {
    const type = document.getElementById('task-type').value;
    document.getElementById('date-col').style.display = type === 'once' ? 'block' : 'none';
    document.getElementById('custom-days-container').classList.toggle('hidden', type !== 'custom');
}

// ==========================================
// IMPORTAR / EXPORTAR
// ==========================================
function exportData() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(AppData));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    const date = new Date().toISOString().split('T')[0];
    dlAnchorElem.setAttribute("download", `NAVAJO_backup_${date}.json`);
    dlAnchorElem.click();
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const imported = JSON.parse(e.target.result);
            if(imported.tasks && imported.config) {
                Object.assign(AppData, imported);
                saveData();
                renderMain();
                alert("Datos importados correctamente");
                closeModal('settings-modal');
            } else {
                alert("Formato de archivo inválido");
            }
        } catch (err) {
            alert("Error al leer el archivo JSON");
        }
    };
    reader.readAsText(file);
}

// ==========================================
// EVENT LISTENERS MAIN
// ==========================================
function setupEventListeners() {
    // Welcome
    document.getElementById('btn-start').addEventListener('click', () => {
        AppData.config.theme = document.getElementById('welcome-theme').value;
        AppData.config.welcomeCompleted = true;
        saveData();
        document.getElementById('welcome-screen').classList.add('hidden');
        document.getElementById('main-screen').classList.remove('hidden');
        initApp(); // re-init
    });

    // Modals
    document.getElementById('fab-add').addEventListener('click', () => openTaskForm());
    document.getElementById('btn-cancel-task').addEventListener('click', () => closeModal('task-modal'));
    document.getElementById('btn-save-task').addEventListener('click', saveTaskFromForm);
    
    document.getElementById('task-type').addEventListener('change', toggleTaskTypeFields);
    
    document.getElementById('btn-settings').addEventListener('click', () => {
        document.getElementById('settings-theme').value = AppData.config.theme;
        document.getElementById('settings-notify-before').value = AppData.config.notifyBefore;
        document.getElementById('settings-notify-exact').checked = AppData.config.notifyExact;
        openModal('settings-modal');
    });
    
    document.getElementById('btn-close-settings').addEventListener('click', () => {
        AppData.config.theme = document.getElementById('settings-theme').value;
        AppData.config.notifyBefore = document.getElementById('settings-notify-before').value;
        AppData.config.notifyExact = document.getElementById('settings-notify-exact').checked;
        saveData();
        applyTheme(AppData.config.theme);
        closeModal('settings-modal');
    });

    // Context Menu actions
    document.getElementById('ctx-edit').addEventListener('click', () => {
        openTaskForm(currentContextMenuTask);
        document.getElementById('context-menu').classList.add('hidden');
    });
    document.getElementById('ctx-duplicate').addEventListener('click', () => {
        duplicateTask(currentContextMenuTask);
        document.getElementById('context-menu').classList.add('hidden');
    });
    document.getElementById('ctx-toggle').addEventListener('click', () => {
        toggleTaskState(currentContextMenuTask);
        document.getElementById('context-menu').classList.add('hidden');
    });
    document.getElementById('ctx-snooze').addEventListener('click', () => {
        snoozeTask(currentContextMenuTask);
        document.getElementById('context-menu').classList.add('hidden');
    });
    document.getElementById('ctx-delete').addEventListener('click', () => {
        deleteTask(currentContextMenuTask.id);
        document.getElementById('context-menu').classList.add('hidden');
    });

    // Ocultar menú contextual al tocar fuera
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu') && !e.target.closest('.task-item')) {
            document.getElementById('context-menu').classList.add('hidden');
        }
    });

    // Settings actions
    document.getElementById('btn-export').addEventListener('click', exportData);
    document.getElementById('btn-import-trigger').addEventListener('click', () => document.getElementById('file-import').click());
    document.getElementById('file-import').addEventListener('change', importData);
    document.getElementById('btn-reset-app').addEventListener('click', () => {
        if(confirm("¿Borrar TODOS los datos? Esta acción no se puede deshacer.")) {
            localStorage.removeItem('navajo_data');
            location.reload();
        }
    });
}

// ==========================================
// SERVICE WORKER REGISTRATION
// ==========================================
function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js')
        .then(reg => console.log('SW Registered', reg))
        .catch(err => console.error('SW Error', err));
    }
}

// ARRANQUE
window.addEventListener('DOMContentLoaded', initApp);

