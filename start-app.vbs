' Starts CTV without any console window. First run installs dependencies in a visible window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists("node_modules") Then
  sh.Run "cmd /c npm install", 1, True
End If
sh.Run "cmd /c npm run app", 0, False
