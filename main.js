document.addEventListener('DOMContentLoaded', function() {
    
    // --- VARIABLES GLOBALES ---
    let currentUserId = null;
    let currentTaskListId = null;
    let currentUserRole = null;
    // FIRESTORE: Los listeners ahora son funciones de cancelación
    let unsubscribeTaskList = null;
    let unsubscribeMembers = null;
    let unsubscribeUserLists = null;
    let lastKnownServerState = null;
    let isReadOnlyMode = false;
    
    const debounce = (func, delay) => {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    };

    // --- SELECTORES DE ELEMENTOS ---
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginForm = document.getElementById('login-form');
    const authErrorEl = document.getElementById('auth-error');
    const tasksTbody = document.getElementById('tasks-tbody');
    
    let taskCounter = 0;

    const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
    [...tooltipTriggerList].map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl));

    // --- FUNCIONES DE AUTENTICACIÓN (Sin cambios) ---
    const showAuthMessage = (message, type = 'danger') => {
        authErrorEl.textContent = message;
        authErrorEl.className = `alert alert-${type}`;
        authErrorEl.style.display = 'block';
    };
    const clearAuthError = () => { authErrorEl.style.display = 'none'; };
    const handleLogin = (e) => { e.preventDefault(); clearAuthError(); auth.signInWithEmailAndPassword(loginForm.email.value, loginForm.password.value).catch(error => showAuthMessage("Correo o contraseña incorrectos.")); };
    const handleSignUp = () => { clearAuthError(); if (loginForm.password.value.length < 6) { showAuthMessage("La contraseña debe tener al menos 6 caracteres."); return; } auth.createUserWithEmailAndPassword(loginForm.email.value, loginForm.password.value).catch(error => showAuthMessage(error.code === 'auth/email-already-in-use' ? "Este correo ya está registrado." : "Error: " + error.message)); };
    const handleGoogleSignIn = () => { clearAuthError(); auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(err => showAuthMessage("Error con Google: " + err.message)); };
    const handleForgotPassword = (e) => { e.preventDefault(); clearAuthError(); if (!loginForm.email.value) { showAuthMessage("Ingresa tu correo."); return; } auth.sendPasswordResetEmail(loginForm.email.value).then(() => showAuthMessage("Correo de recuperación enviado.", "success")).catch(() => showAuthMessage("Error al enviar el correo.")); };
    
    const handleLogout = () => {
        // FIRESTORE: Cancelar suscripciones
        if (unsubscribeTaskList) unsubscribeTaskList();
        if (unsubscribeMembers) unsubscribeMembers();
        if (unsubscribeUserLists) unsubscribeUserLists();
        history.pushState(null, '', window.location.pathname);
        auth.signOut();
    };

    // --- OBSERVADOR DE AUTENTICACIÓN ---
    auth.onAuthStateChanged(user => {
        if (user) { handleUserLogin(user); } 
        else {
            currentUserId = null;
            currentTaskListId = null;
            currentUserRole = null;
            authContainer.style.display = 'flex';
            appContainer.style.display = 'none';
            loginForm.reset();
        }
    });

    // --- GESTIÓN DE USUARIOS ---
    function handleUserLogin(user) {
        // FIRESTORE: Guardar info de usuario en Firestore
        const userDocRef = db.collection('users').doc(user.uid);
        userDocRef.get().then(doc => {
            if (!doc.exists) {
                const registrationDate = new Date();
                const newUserInfo = {
                    email: user.email,
                    registrationDate: firebase.firestore.Timestamp.fromDate(registrationDate),
                    authProvider: user.providerData[0].providerId
                };
                userDocRef.set(newUserInfo).then(() => proceedToApp(user));
            } else {
                proceedToApp(user);
            }
        });
    }

    function proceedToApp(user) {
        currentUserId = user.uid;
        document.getElementById('sidebar-user-info').textContent = user.email;
        authContainer.style.display = 'none';
        appContainer.style.display = 'flex';
        initializeAppLogic();
        initShareFunctionality();
        initTaskListsModal();
    }

    // --- LÓGICA DE LA APLICACIÓN ---
    async function initializeAppLogic() {
        document.getElementById('new-task-list-btn').addEventListener('click', () => loadNewTaskListState(true));
        const taskListNameInput = document.getElementById('taskListName');
        taskListNameInput.addEventListener('input', debouncedSaveToFirestore);
        document.getElementById('tasks').addEventListener('change', debouncedSaveToFirestore);
        document.getElementById('add-task').addEventListener('click', () => { addTaskRow(); debouncedSaveToFirestore(); });

        const sidebarToggle = document.getElementById('sidebar-toggle');
        sidebarToggle.addEventListener('click', () => { document.body.classList.toggle('sidebar-collapsed'); sidebarToggle.querySelector('i').className = document.body.classList.contains('sidebar-collapsed') ? 'bi bi-chevron-right' : 'bi-chevron-left'; });
        sidebarToggle.querySelector('i').className = document.body.classList.contains('sidebar-collapsed') ? 'bi bi-chevron-right' : 'bi-chevron-left';
        initSortable(tasksTbody);

        const initialTaskListId = getTaskListIdFromUrl();
        if (initialTaskListId) { await listenToTaskList(initialTaskListId); } 
        else { loadNewTaskListState(false); }
    }
  
    async function loadNewTaskListState(confirmFirst = false) {
        if (confirmFirst && !confirm("¿Crear una nueva lista de tareas?")) return;
        if (unsubscribeTaskList) unsubscribeTaskList();
        if (unsubscribeMembers) unsubscribeMembers();
        currentTaskListId = null;
        currentUserRole = 'owner';
        lastKnownServerState = null;
        if (window.location.search !== "") history.pushState(null, '', window.location.pathname);
        setReadOnly(false);
        document.getElementById('share-task-list-btn').style.display = 'none';
        
        // Cargar plantilla por defecto
        try {
            const response = await fetch('default-task-list.json');
            const data = await response.json();
            loadTasksFromJSON(data);
        } catch (e) {
            loadTasksFromJSON({ taskListName: 'Nueva Lista de Tareas', tasks: [] });
        }
        
        saveTaskListToFirestore();
    }    

    // --- FUNCIONES DE DATOS (FIRESTORE) ---
    async function saveTaskListToFirestore() {
        if (!currentUserId || isReadOnlyMode) return;
        const data = getTasksData();
        const taskListDataToSave = {
            ...data,
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        };

        lastKnownServerState = JSON.stringify(taskListDataToSave);

        if (!currentTaskListId) {
            updateSaveStatus('Creando lista...');
            try {
                // FIRESTORE: Usar .add() para crear un nuevo documento con ID automático
                const newDocRef = await db.collection('tareas').add({
                    ...taskListDataToSave,
                    ownerId: currentUserId,
                    creationDate: firebase.firestore.FieldValue.serverTimestamp()
                });
                
                currentTaskListId = newDocRef.id;

                // FIRESTORE: Añadir al propietario a la subcolección de miembros
                await db.collection('tareas').doc(currentTaskListId).collection('members').doc(currentUserId).set({
                    email: auth.currentUser.email,
                    role: 'owner'
                });

                // FIRESTORE: Añadir referencia en la lista de listas del usuario
                 await db.collection('user_task_lists').doc(currentUserId).collection('lists').doc(currentTaskListId).set({
                    name: data.taskListName,
                    role: 'owner'
                });

                const newUrl = `${window.location.pathname}?id=${currentTaskListId}`;
                history.pushState({ path: newUrl }, '', newUrl);
                await listenToTaskList(currentTaskListId);
                updateSaveStatus('Guardado');
            } catch (error) {
                console.error("Error creando lista:", error);
                updateSaveStatus('Error al crear', true);
            }
        } else {
            updateSaveStatus('Guardando...');
            try {
                // FIRESTORE: Usar .update() para modificar un documento existente
                const batch = db.batch();
                const taskListRef = db.collection('tareas').doc(currentTaskListId);
                batch.update(taskListRef, taskListDataToSave);

                // Actualizar el nombre en las listas de todos los miembros
                const membersSnapshot = await db.collection('tareas').doc(currentTaskListId).collection('members').get();
                membersSnapshot.forEach(memberDoc => {
                    const userListRef = db.collection('user_task_lists').doc(memberDoc.id).collection('lists').doc(currentTaskListId);
                    batch.update(userListRef, { name: data.taskListName });
                });

                await batch.commit();
                updateSaveStatus('Guardado');
            } catch (error) {
                console.error("Error guardando:", error);
                updateSaveStatus('Error al guardar', true);
            }
        }
    }
    
    const debouncedSaveToFirestore = debounce(saveTaskListToFirestore, 1500);

    function getTaskListIdFromUrl() {
        return new URLSearchParams(window.location.search).get('id');
    }

    async function listenToTaskList(taskListId) {
        if (!currentUserId) return;
        if (unsubscribeTaskList) unsubscribeTaskList();

        currentTaskListId = taskListId;
        
        // FIRESTORE: Obtener el rol del usuario de la subcolección de miembros
        const memberDoc = await db.collection('tareas').doc(taskListId).collection('members').doc(currentUserId).get();
        
        if (!memberDoc.exists) {
            alert("No tienes acceso a esta lista.");
            loadNewTaskListState(false);
            return;
        }
        currentUserRole = memberDoc.data().role;
        isReadOnlyMode = (currentUserRole === 'viewer');
        setReadOnly(isReadOnlyMode);
        
        const shareBtn = document.getElementById('share-task-list-btn');
        shareBtn.style.display = 'block';
        shareBtn.disabled = (currentUserRole !== 'owner');

        updateSaveStatus('Cargando lista...');
        // FIRESTORE: Escuchar cambios en el documento principal de la lista
        unsubscribeTaskList = db.collection('tareas').doc(taskListId).onSnapshot((doc) => {
            if (doc.exists) {
                const serverData = doc.data();
                // Compara sin los timestamps para evitar bucles de actualización
                const localData = getTasksData();
                if (JSON.stringify(serverData.tasks) === JSON.stringify(localData.tasks) && serverData.taskListName === localData.taskListName) {
                     updateHeaderKPIs(serverData.tasks); // Asegura que los KPIs se actualicen
                    return;
                }
                
                lastKnownServerState = JSON.stringify(serverData); 
                updateSaveStatus('Actualizando...');
                loadTasksFromJSON(serverData);
                updateSaveStatus('Actualizado');
            } else {
                alert("La lista ya no existe.");
                if (unsubscribeTaskList) unsubscribeTaskList();
                loadNewTaskListState(false);
            }
        }, error => {
            console.error("Error escuchando la lista:", error);
            updateSaveStatus('Error de conexión', true);
        });
    }

    // --- FUNCIONES PARA COMPARTIR (FIRESTORE) ---
    let shareModalInstance = null;

    function initShareFunctionality() {
        if (!shareModalInstance) shareModalInstance = new bootstrap.Modal(document.getElementById('shareModal'));
        document.getElementById('share-task-list-btn').addEventListener('click', openShareModal);
        document.getElementById('add-user-btn').addEventListener('click', addUserToList);
        document.getElementById('user-access-list').addEventListener('click', (e) => { if (e.target.closest('.remove-user-btn')) removeUserFromList(e.target.closest('.remove-user-btn').dataset.uid); });
        document.getElementById('user-access-list').addEventListener('change', (e) => { if (e.target.matches('.role-select')) updateUserRole(e.target.dataset.uid, e.target.value); });
    }

    function openShareModal() {
        if (!currentTaskListId) return;
        document.getElementById('share-error').style.display = 'none';
        document.getElementById('share-email-input').value = '';
        if (unsubscribeMembers) unsubscribeMembers();
        
        // FIRESTORE: Escuchar la subcolección de miembros
        unsubscribeMembers = db.collection('tareas').doc(currentTaskListId).collection('members').onSnapshot(snapshot => {
            const members = {};
            snapshot.forEach(doc => { members[doc.id] = doc.data(); });
            renderUserList(members);
        });
        shareModalInstance.show();
    }

    function renderUserList(members) {
        const userListEl = document.getElementById('user-access-list');
        userListEl.innerHTML = '';
        if (!members) return;
        const isOwner = members[currentUserId]?.role === 'owner';
        Object.entries(members).forEach(([uid, userData]) => {
            const li = document.createElement('li');
            li.className = 'list-group-item d-flex justify-content-between align-items-center';
            const isCurrentUserOwner = (uid === currentUserId && userData.role === 'owner');
            const roleDisplay = isCurrentUserOwner ? `<span class="badge bg-success rounded-pill">Propietario</span>` : `<select class="form-select form-select-sm role-select" data-uid="${uid}" ${!isOwner ? 'disabled' : ''}><option value="editor" ${userData.role === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${userData.role === 'viewer' ? 'selected' : ''}>Solo Lectura</option></select>`;
            const actionBtn = (isOwner && uid !== currentUserId) ? `<button class="btn btn-sm btn-outline-danger remove-user-btn" data-uid="${uid}"><i class="bi bi-trash"></i></button>` : '';
            li.innerHTML = `<div>${userData.email || '...'}</div><div class="d-flex align-items-center gap-2"><div class="role-select-cell">${roleDisplay}</div><div class="action-btn-cell">${actionBtn}</div></div>`;
            userListEl.appendChild(li);
        });
    }

    async function updateUserRole(uid, newRole) {
        if (!currentTaskListId) return;
        const batch = db.batch();
        batch.update(db.collection('tareas').doc(currentTaskListId).collection('members').doc(uid), { role: newRole });
        batch.update(db.collection('user_task_lists').doc(uid).collection('lists').doc(currentTaskListId), { role: newRole });
        await batch.commit();
    }

    async function addUserToList() {
        const email = document.getElementById('share-email-input').value.trim();
        const errorEl = document.getElementById('share-error');
        errorEl.style.display = 'none';
        if (!email) { errorEl.textContent = 'Introduce un correo.'; errorEl.style.display = 'block'; return; }
        
        try {
            // FIRESTORE: Buscar usuario por email
            const userQuery = await db.collection('users').where('email', '==', email).limit(1).get();
            if (userQuery.empty) { throw new Error('Usuario no encontrado.'); }
            const targetUserDoc = userQuery.docs[0];
            const targetUid = targetUserDoc.id;

            const role = document.getElementById('share-role-select').value;
            const taskListData = getTasksData();
            
            const batch = db.batch();
            batch.set(db.collection('tareas').doc(currentTaskListId).collection('members').doc(targetUid), { email: email, role: role });
            batch.set(db.collection('user_task_lists').doc(targetUid).collection('lists').doc(currentTaskListId), { name: taskListData.taskListName, role: role });
            await batch.commit();

            document.getElementById('share-email-input').value = '';
        } catch (error) {
            errorEl.textContent = 'Error: ' + error.message;
            errorEl.style.display = 'block';
        }
    }

    async function removeUserFromList(uidToRemove) {
        if (!confirm("¿Quitar acceso a este usuario?")) return;
        const batch = db.batch();
        batch.delete(db.collection('tareas').doc(currentTaskListId).collection('members').doc(uidToRemove));
        batch.delete(db.collection('user_task_lists').doc(uidToRemove).collection('lists').doc(currentTaskListId));
        await batch.commit();
    }

    // --- LISTAR Y ABRIR LISTAS (FIRESTORE) ---
    let taskListsModalInstance = null;

    function initTaskListsModal() {
        if (!taskListsModalInstance) taskListsModalInstance = new bootstrap.Modal(document.getElementById('taskListsModal'));
        document.getElementById('open-task-lists-btn').addEventListener('click', () => taskListsModalInstance.show());
        if (unsubscribeUserLists) unsubscribeUserLists();
        
        // FIRESTORE: Escuchar la subcolección de listas del usuario
        unsubscribeUserLists = db.collection('user_task_lists').doc(currentUserId).collection('lists').orderBy('name').onSnapshot(snapshot => {
            const lists = {};
            snapshot.forEach(doc => { lists[doc.id] = doc.data(); });
            renderTaskLists(lists);
        });

        document.getElementById('task-list-container').addEventListener('click', e => {
            const deleteBtn = e.target.closest('.delete-task-list-btn');
            if (deleteBtn) { e.stopPropagation(); deleteTaskList(deleteBtn.dataset.id, deleteBtn.dataset.name); } 
            else { const row = e.target.closest('.task-list-row'); if (row) window.location.href = row.dataset.href; }
        });
    }

    function renderTaskLists(lists) {
        const container = document.getElementById('task-list-container');
        if (Object.keys(lists).length === 0) { container.innerHTML = '<p class="text-muted text-center mt-3">No tienes listas.</p>'; return; }
        const tableRowsHtml = Object.entries(lists).map(([id, data]) => `
            <tr class="task-list-row align-middle" data-href="${window.location.pathname}?id=${id}">
                <td>${data.name || '...'}</td>
                <td><span class="badge bg-light text-dark border rounded-pill">${data.role || '...'}</span></td>
                <td class="text-end">${data.role === 'owner' ? `<button class="btn btn-sm btn-outline-danger delete-task-list-btn" data-id="${id}" data-name="${data.name || ''}"><i class="bi bi-trash"></i></button>` : ''}</td>
            </tr>`).join('');
        container.innerHTML = `<table class="table table-hover"><thead><tr><th>Nombre</th><th>Acceso</th><th></th></tr></thead><tbody>${tableRowsHtml}</tbody></table>`;
    }

    async function deleteTaskList(listId, listName) {
        if (!confirm(`¿Eliminar la lista "${listName}"? Es irreversible.`)) return;
        updateSaveStatus('Eliminando...');
        
        // FIRESTORE: Borrar un documento y sus subcolecciones es complejo.
        // Se requiere un borrado en batch o una Cloud Function para asegurar la atomicidad.
        const batch = db.batch();
        const membersSnapshot = await db.collection('tareas').doc(listId).collection('members').get();
        membersSnapshot.forEach(doc => {
            batch.delete(db.collection('user_task_lists').doc(doc.id).collection('lists').doc(listId)); // Borrar de user_task_lists
            batch.delete(doc.ref); // Borrar miembro
        });
        batch.delete(db.collection('tareas').doc(listId)); // Borrar lista principal
        await batch.commit();

        updateSaveStatus('Lista eliminada');
        if (currentTaskListId === listId) {
            if(taskListsModalInstance) taskListsModalInstance.hide();
            loadNewTaskListState(false);
        }
    }

    // --- MODO SOLO LECTURA ---
    function setReadOnly(isReadOnly) {
        isReadOnlyMode = isReadOnly;
        document.querySelectorAll('#app-container input, #app-container select, #app-container button').forEach(el => {
            if (!el.closest('.modal')) el.disabled = isReadOnly;
        });
        document.querySelectorAll('.drag-handle').forEach(el => { el.style.cursor = isReadOnly ? 'default' : 'move'; });
    }

    // --- EVENT LISTENERS GENERALES ---
    loginForm.addEventListener('submit', handleLogin);
    document.getElementById('signup-btn').addEventListener('click', handleSignUp);
    document.getElementById('google-signin-btn').addEventListener('click', handleGoogleSignIn);
    document.getElementById('logout-btn-sidebar').addEventListener('click', handleLogout);
    document.getElementById('forgot-password-link').addEventListener('click', handleForgotPassword);

    // --- LÓGICA DE TAREAS ---
    function updateHeaderKPIs(tasks) {
        const total = tasks.length;
        const pending = tasks.filter(t => t.status === 'Pendiente').length;
        const inProgress = tasks.filter(t => t.status === 'En Progreso').length;
        const completed = tasks.filter(t => t.status === 'Completada').length;
        document.querySelector('#kpi1 .header-kpi-value').textContent = total;
        document.querySelector('#kpi2 .header-kpi-value').textContent = pending;
        document.querySelector('#kpi3 .header-kpi-value').textContent = inProgress;
        document.querySelector('#kpi4 .header-kpi-value').textContent = completed;
    }

    function addTaskRow(data = {}) {
        taskCounter++;
        const newRow = document.createElement('tr');
        newRow.id = `task-row-${taskCounter}`;
        newRow.innerHTML = `
            <td class="drag-handle"><i class="bi bi-grip-vertical"></i></td>
            <td><input type="text" class="form-control form-control-sm" name="taskName" value="${data.name || ''}"></td>
            <td><input type="text" class="form-control form-control-sm" name="taskResponsible" value="${data.responsible || ''}"></td>
            <td><input type="date" class="form-control form-control-sm" name="taskStartDate" value="${data.startDate || ''}"></td>
            <td><input type="date" class="form-control form-control-sm" name="taskEndDate" value="${data.endDate || ''}"></td>
            <td><select class="form-select form-select-sm" name="taskStatus"><option>Pendiente</option><option>En Progreso</option><option>Completada</option></select></td>
            <td><select class="form-select form-select-sm" name="taskPriority"><option>Baja</option><option>Media</option><option>Alta</option></select></td>
            <td><button type="button" class="btn btn-sm btn-outline-secondary" onclick="removeRow('task-row-${taskCounter}')">X</button></td>`;
        tasksTbody.appendChild(newRow);
        if(data.status) newRow.querySelector('[name=taskStatus]').value = data.status;
        if(data.priority) newRow.querySelector('[name=taskPriority]').value = data.priority;
        updateHeaderKPIs(getTasksData().tasks);
    }

    window.removeRow = function(rowId) { document.getElementById(rowId).remove(); updateHeaderKPIs(getTasksData().tasks); debouncedSaveToFirestore(); }
    
    function getTasksData() {
        const data = { taskListName: document.getElementById('taskListName').value, tasks: [] };
        tasksTbody.querySelectorAll('tr').forEach(r => data.tasks.push({ name: r.querySelector('[name=taskName]').value, responsible: r.querySelector('[name=taskResponsible]').value, startDate: r.querySelector('[name=taskStartDate]').value, endDate: r.querySelector('[name=taskEndDate]').value, status: r.querySelector('[name=taskStatus]').value, priority: r.querySelector('[name=taskPriority]').value, }));
        return data;
    }
    
    function loadTasksFromJSON(data) {
        tasksTbody.innerHTML = '';
        taskCounter = 0;
        document.getElementById('taskListName').value = data.taskListName || 'Nueva Lista';
        if (Array.isArray(data.tasks)) data.tasks.forEach(taskData => addTaskRow(taskData));
        updateHeaderKPIs(data.tasks || []);
    }

    function initSortable(tbodyElement) { if (tbodyElement) new Sortable(tbodyElement, { animation: 150, handle: '.drag-handle', onEnd: debouncedSaveToFirestore, }); }
    
    // --- IMPORT/EXPORT/COPIAR ---
    function downloadFile(content, filename, mimeType) { const blob = new Blob([`\uFEFF${content}`], { type: mimeType }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); }
    document.getElementById('export-model-btn').addEventListener('click', () => { const data = getTasksData(); downloadFile(JSON.stringify(data, null, 2), `tareas_${data.taskListName.replace(/[^a-z0-9]/gi, '_')}.json`, 'application/json'); });
    document.getElementById('import-file-input').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { try { const params = JSON.parse(e.target.result); if (!params.tasks) throw new Error("Formato inválido."); loadTasksFromJSON(params); alert("Tareas importadas."); saveTaskListToFirestore(); } catch { alert("Archivo JSON no válido."); } }; reader.readAsText(file); event.target.value = ''; });
    document.getElementById('copy-tasks-btn').addEventListener('click', () => { const table = document.querySelector('#tasks table'); if (!table) return; const tsv = Array.from(table.querySelectorAll('tr')).map(r => Array.from(r.querySelectorAll('th, td')).slice(1, -1).map(c => `"${(c.querySelector('input, select')?.value || c.textContent).trim()}"`).join('\t')).join('\n'); navigator.clipboard.writeText(tsv).then(() => alert('Tabla copiada.')); });

    // --- ESTADO DE GUARDADO ---
    const saveStatusEl = document.getElementById('save-status');
    let saveTimeout;
    function updateSaveStatus(status, isError = false) { clearTimeout(saveTimeout); saveStatusEl.style.opacity = 1; if (isError) { saveStatusEl.innerHTML = `<i class="bi bi-x-circle-fill text-danger"></i> ${status}`; } else if (status.includes('...')) { saveStatusEl.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${status}`; } else { saveStatusEl.innerHTML = `<i class="bi bi-check-circle-fill text-success"></i> ${status}`; saveTimeout = setTimeout(() => { saveStatusEl.style.opacity = 0; }, 2000); } }
});
Use code with caution.
JavaScript
Ahora, el archivo admin.html también necesita ser actualizado para usar Firestore.
Archivo 3: admin.html (Refactorizado para Firestore)
Generated html
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Administración - Gestor de Tareas</title>
    
    <link rel="icon" type="image/png" href="https://alowenerm.github.io/Ciclos/brickwise-ft.png">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
    <link rel="stylesheet" href="style.css">
    
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>

</head>
<body class="page-admin">

    <div id="auth-container">
        <div class="card auth-card">
            <div class="card-body">
                <div class="text-center mb-4"><img src="https://alowenerm.github.io/Ciclos/brickwise-ft.png" alt="Logo" style="height: 80px;"><h4 class="mt-3">Panel de Administración</h4><p class="text-muted">Inicia sesión para continuar</p></div>
                <div id="auth-error" class="alert alert-danger" style="display: none;"></div>
                <div class="d-grid gap-2"><button id="google-signin-btn" class="btn btn-primary btn-lg"><i class="bi bi-google me-2"></i> Iniciar Sesión con Google</button></div>
            </div>
        </div>
    </div>

    <div id="app-container" style="display: none;">
        <div id="app-header" class="sticky-top"><div class="container"><div class="d-flex justify-content-between align-items-center"><div class="d-flex align-items-center gap-3"><img src="https://alowenerm.github.io/Ciclos/brickwise-ft.png" alt="Logo" style="height: 50px;"><h4 class="mb-0">Panel de Administración</h4></div><div class="text-end"><div id="user-info" class="fw-bold"></div><a href="#" id="logout-btn" style="text-decoration: none;">Cerrar Sesión</a></div></div></div></div>
        <div class="container mt-4">
            <ul class="nav nav-tabs" id="adminTab" role="tablist">
                <li class="nav-item" role="presentation"><button class="nav-link active" id="users-tab" data-bs-toggle="tab" data-bs-target="#users-panel">Gestión de Usuarios</button></li>
                <li class="nav-item" role="presentation"><button class="nav-link" id="task-lists-tab" data-bs-toggle="tab" data-bs-target="#task-lists-panel">Gestión de Listas de Tareas</button></li>
            </ul>
            <div class="tab-content pt-3" id="adminTabContent">
                <div class="tab-pane fade show active" id="users-panel" role="tabpanel"><div class="card"><div class="card-header d-flex justify-content-between align-items-center"><h5 class="card-title mb-0">Usuarios Registrados</h5><input type="text" id="user-search-filter" class="form-control form-control-sm" placeholder="Buscar por email..." style="width: 300px;"></div><div class="card-body"><div id="users-table-container" class="table-responsive"><p class="text-muted">Cargando usuarios...</p></div></div></div></div>
                <div class="tab-pane fade" id="task-lists-panel" role="tabpanel"><div class="card"><div class="card-header d-flex justify-content-between align-items-center"><h5 class="card-title mb-0">Listas de Tareas</h5><input type="text" id="task-list-search-filter" class="form-control form-control-sm" placeholder="Buscar por nombre o propietario..." style="width: 300px;"></div><div id="task-lists-table-container" class="table-responsive"><p class="text-muted p-3">Cargando listas...</p></div></div></div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="accessModal" tabindex="-1"><div class="modal-dialog modal-lg modal-dialog-centered"><div class="modal-content"><div class="modal-header"><h5 class="modal-title" id="access-title">Acceso a la Lista</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div id="access-container"><p class="text-muted">Cargando...</p></div><hr><div><h6>Añadir Usuario</h6><div id="add-user-error" class="alert alert-danger" style="display: none;"></div><div class="input-group"><input type="email" id="add-user-email" class="form-control" placeholder="Email del usuario"><select id="add-user-role" class="form-select" style="flex: 0 0 140px;"><option value="viewer">Solo Lectura</option><option value="editor">Editor</option><option value="owner">Propietario</option></select><button id="add-user-btn" class="btn btn-success">Añadir</button></div></div></div></div></div></div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="firebase-config.js"></script>
    <script>
    document.addEventListener('DOMContentLoaded', function() {
        const authErrorEl = document.getElementById('auth-error');
        let unsubscribeUsers, unsubscribeTaskLists, unsubscribeMembers, accessModal;

        auth.onAuthStateChanged(user => {
            if (user) { checkIfAdmin(user); }
            else { document.getElementById('auth-container').style.display = 'flex'; document.getElementById('app-container').style.display = 'none'; }
        });

        const checkIfAdmin = async (user) => {
            // FIRESTORE: Comprobar si el usuario es admin
            const adminDoc = await db.collection('admins').doc(user.email).get();
            if (adminDoc.exists) {
                document.getElementById('user-info').textContent = user.email;
                document.getElementById('auth-container').style.display = 'none';
                document.getElementById('app-container').style.display = 'block';
                initializeAppLogic();
            } else {
                authErrorEl.textContent = 'Acceso denegado.';
                authErrorEl.style.display = 'block';
                auth.signOut();
            }
        };

        document.getElementById('google-signin-btn').addEventListener('click', () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()));
        document.getElementById('logout-btn').addEventListener('click', () => auth.signOut());

        function initializeAppLogic() {
            accessModal = new bootstrap.Modal(document.getElementById('accessModal'));
            
            // FIRESTORE: Listeners para colecciones
            unsubscribeUsers = db.collection('users').onSnapshot(snapshot => renderTable(snapshot, 'users-table-container', renderUserRow, 'user-search-filter', 'email'));
            unsubscribeTaskLists = db.collection('tareas').onSnapshot(snapshot => renderTable(snapshot, 'task-lists-table-container', renderTaskListRow, 'task-list-search-filter', 'taskListName'));

            document.getElementById('users-table-container').addEventListener('click', handleUserActions);
            document.getElementById('task-lists-table-container').addEventListener('click', handleTaskListActions);
            document.getElementById('access-container').addEventListener('click', handleAccessActions);
            document.getElementById('add-user-btn').addEventListener('click', handleAddUserToList);
        }

        function renderTable(snapshot, containerId, rowRenderer, filterId, searchField) {
            const container = document.getElementById(containerId);
            const searchTerm = document.getElementById(filterId)?.value.toLowerCase() || '';
            let rowsHtml = '';
            snapshot.forEach(doc => {
                const data = doc.data();
                if (!searchTerm || (data[searchField] && data[searchField].toLowerCase().includes(searchTerm))) {
                    rowsHtml += rowRenderer(doc.id, data);
                }
            });
            const tableHeaders = containerId === 'users-table-container' ? '<th>Email</th><th>Registro</th><th>Proveedor</th><th></th>' : '<th>Nombre</th><th>Propietario</th><th>Modificado</th><th>Tareas</th><th></th>';
            container.innerHTML = `<table class="table table-hover"><thead><tr>${tableHeaders}</tr></thead><tbody>${rowsHtml || '<tr><td colspan="5" class="text-center text-muted">No hay datos.</td></tr>'}</tbody></table>`;
        }

        const renderUserRow = (id, data) => `<tr><td>${data.email}</td><td>${data.registrationDate.toDate().toLocaleDateString()}</td><td>${data.authProvider}</td><td class="text-end"><button class="btn btn-sm btn-danger" data-action="delete-user" data-uid="${id}" data-email="${data.email}">Eliminar</button></td></tr>`;
        
        const renderTaskListRow = (id, data) => `<tr class="clickable-row" data-list-id="${id}" data-list-name="${data.taskListName || ''}"><td>${data.taskListName || 'Sin Nombre'}</td><td>${data.ownerId ? '...' : 'N/A'}</td><td>${data.lastUpdated ? data.lastUpdated.toDate().toLocaleString() : 'N/A'}</td><td>${data.tasks?.length || 0}</td><td class="text-end"><button class="btn btn-sm btn-light" data-action="delete-list" data-list-id="${id}" data-list-name="${data.taskListName || ''}"><i class="bi bi-trash"></i></button></td></tr>`;

        async function handleTaskListActions(e) {
            const deleteBtn = e.target.closest('button[data-action="delete-list"]');
            if (deleteBtn) { e.stopPropagation(); handleDeleteTaskList(deleteBtn.dataset.listId, deleteBtn.dataset.listName); return; }
            const target = e.target.closest('.clickable-row');
            if (!target) return;
            const listId = target.dataset.listId;
            document.getElementById('access-title').textContent = `Acceso: ${target.dataset.listName}`;
            if(unsubscribeMembers) unsubscribeMembers();
            unsubscribeMembers = db.collection('tareas').doc(listId).collection('members').onSnapshot(snapshot => {
                const members = [];
                snapshot.forEach(doc => members.push({id: doc.id, ...doc.data()}));
                renderAccessList(members, listId);
            });
            accessModal.show();
        }

        function handleUserActions(e) { /* Lógica de borrado de usuario es compleja, dejar pendiente */ }
        
        async function handleDeleteTaskList(listId, listName) {
            if (!confirm(`¿ELIMINAR la lista "${listName}"?`)) return;
            const batch = db.batch();
            const members = await db.collection('tareas').doc(listId).collection('members').get();
            members.forEach(doc => {
                batch.delete(db.collection('user_task_lists').doc(doc.id).collection('lists').doc(listId));
                batch.delete(doc.ref);
            });
            batch.delete(db.collection('tareas').doc(listId));
            await batch.commit();
            alert(`Lista "${listName}" eliminada.`);
            accessModal.hide();
        }

        function renderAccessList(members, listId) {
            const container = document.getElementById('access-container');
            container.dataset.listId = listId;
            const rowsHtml = members.map(member => `<tr><td>${member.email}</td><td><select class="form-select form-select-sm" data-uid="${member.id}" ${member.role === 'owner' ? 'disabled' : ''}><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Lectura</option><option value="editor" ${member.role === 'editor' ? 'selected' : ''}>Editor</option><option value="owner" ${member.role === 'owner' ? 'selected' : ''}>Propietario</option></select></td><td class="text-end">${member.role !== 'owner' ? `<button class="btn btn-sm btn-success" data-action="save-role" data-uid="${member.id}">Guardar</button> <button class="btn btn-sm btn-danger" data-action="remove-user" data-uid="${member.id}">Quitar</button>` : ''}</td></tr>`).join('');
            container.innerHTML = `<table class="table table-sm"><thead><tr><th>Email</th><th>Rol</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
        }
        
        async function handleAccessActions(e) {
            const listId = e.currentTarget.dataset.listId;
            const { action, uid } = e.target.dataset;
            if (!action || !uid) return;
            
            if (action === 'save-role') {
                const newRole = document.querySelector(`select[data-uid="${uid}"]`).value;
                if (newRole === 'owner') {
                    if (!confirm('¿Transferir propiedad?')) return;
                    const listDoc = await db.collection('tareas').doc(listId).get();
                    const oldOwnerId = listDoc.data().ownerId;
                    const batch = db.batch();
                    batch.update(db.collection('tareas').doc(listId), { ownerId: uid });
                    batch.update(db.collection('tareas').doc(listId).collection('members').doc(oldOwnerId), { role: 'editor' });
                    batch.update(db.collection('user_task_lists').doc(oldOwnerId).collection('lists').doc(listId), { role: 'editor' });
                    await batch.commit();
                }
                await updateUserRole(listId, uid, newRole);
                alert('Rol actualizado.');
            }
            if (action === 'remove-user') {
                if (!confirm('¿Quitar usuario?')) return;
                const batch = db.batch();
                batch.delete(db.collection('tareas').doc(listId).collection('members').doc(uid));
                batch.delete(db.collection('user_task_lists').doc(uid).collection('lists').doc(listId));
                await batch.commit();
                alert('Usuario quitado.');
            }
        }
        const updateUserRole = (listId, uid, role) => {
            const batch = db.batch();
            batch.update(db.collection('tareas').doc(listId).collection('members').doc(uid), { role });
            batch.update(db.collection('user_task_lists').doc(uid).collection('lists').doc(listId), { role });
            return batch.commit();
        }
        
        async function handleAddUserToList() {
            const listId = document.getElementById('access-container').dataset.listId;
            const email = document.getElementById('add-user-email').value.trim();
            const role = document.getElementById('add-user-role').value;
            const errorEl = document.getElementById('add-user-error');
            errorEl.style.display = 'none';
            if(!email || !role || !listId) return;
            try {
                const userQuery = await db.collection('users').where('email', '==', email).limit(1).get();
                if (userQuery.empty) throw new Error('Usuario no registrado.');
                const targetUid = userQuery.docs[0].id;

                if (role === 'owner') { /* Lógica de transferencia de dueño ya está en handleAccessActions */ alert("Usa el selector para transferir la propiedad."); return; }
                
                const listDoc = await db.collection('tareas').doc(listId).get();
                const batch = db.batch();
                batch.set(db.collection('tareas').doc(listId).collection('members').doc(targetUid), { email, role });
                batch.set(db.collection('user_task_lists').doc(targetUid).collection('lists').doc(listId), { name: listDoc.data().taskListName, role });
                await batch.commit();
                alert('Usuario añadido.');
                document.getElementById('add-user-email').value = '';
            } catch(error) { errorEl.textContent = 'Error: ' + error.message; errorEl.style.display = 'block'; }
        }
    });
    </script>
</body>
</html>