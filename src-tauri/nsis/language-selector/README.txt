Bonobos LangDLL - NSIS 3.13
=============================

Cette version ajoute la mise a jour immediate du titre et du texte du dialogue
quand l'utilisateur change la langue dans la liste :
- 1036 : Langue d'installation / Veuillez sélectionner votre langue.
- 1033 : Installer Language / Please select your language.

Les autres langues conservent les textes transmis a LangDialog.

Le dialogue, son icone, les boutons, le retour de l'identifiant de langue et
le comportement d'annulation restent ceux du LangDLL standard.

Compilation depuis un Developer Command Prompt x86 de Visual Studio 2022,
dans le dossier contenant LangDLL.c et LangDLL.res :

  rc /fo LangDLL.res resource.rc
  cl /nologo /LD /O2 /utf-8 /DUNICODE /D_UNICODE /I. LangDLL.c nsis\pluginapi.c LangDLL.res /link /OUT:BonobosLangDLL.dll user32.lib gdi32.lib

Le DLL produit est x86 Unicode. Le nom BonobosLangDLL.dll permet de le tester
sans remplacer le plugin LangDLL.dll original de NSIS.

Important : tester d'abord dans un installateur de test. Ne pas remplacer le
plugin NSIS original.
