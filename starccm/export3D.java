// Exports 3D data for HoMo CFD's 3D viewer into 3D-data/ of the case folder (EnSight Gold):
// - <sim>.case: the car's wall surfaces with Cp, skin friction, wall shear stress, y+ and flow fields,
// - <sim>_flow.case: the simulation's derived parts "Lambda2" (vortex cores: iso-surface of
//   neg(Lambda2)) and "Bad_Cells" (iso-surface around bad mesh cells), when they exist, with the
//   fields defined in the flow (wall-only fields such as CpX = Cp * Norm_Area_x divide by a face
//   area that is zero on some iso-surface faces, which stops STAR-CCM+ with a floating point error),
// - fields.txt: every field function of the simulation, to look up names.
// The two exports run separately, so a problem with the flow parts never costs the car data.
// postprocessing.java plays it at the end; it can also be played on its own in STAR-CCM+
// (File > Macro > Play Macro). Written for STAR-CCM+ 2506 (20.04).
//
// Values are per cell. Fields or parts a simulation does not have are left out. Regions named
// "Cells deleted from ..." (left over from mesh repair, no solution) are skipped. Problems are
// printed to the log and never stop the post-processing.
//
// Optional lines in the case's Settings file:
//   3D-Data/Vortices : false              no Lambda2 part
//   3D-Data/Bad Cells : false             no Bad_Cells part
//   3D-Data/Vortices Iso Value : 30000    only used when the simulation has no "Lambda2" part:
//                                         threshold of neg(Lambda2) for a temporary iso-surface

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Vector;

import star.base.neo.NeoProperty;
import star.common.*;
import star.vis.IsoMode;
import star.vis.IsoPart;

public class export3D extends StarMacro {

    // Scalar fields, by STAR-CCM+ name or display name (punctuation and case ignored).
    private static final String[] FIELDS = {"PressureCoefficient", "TotalPressureCoefficient", "CpX", "CpZ", "CpZ-CpX",
            "SkinFrictionCoefficient", "WallYplus"};
    // Vector fields, exported as their magnitude.
    private static final String[] MAGNITUDES = {"WallShearStress", "Velocity", "VorticityVector"};
    // Fields also exported on the flow parts (defined away from walls).
    private static final String[] FLOW_FIELDS = {"PressureCoefficient", "TotalPressureCoefficient"};
    private static final String[] FLOW_MAGNITUDES = {"Velocity", "VorticityVector"};
    // Wall boundaries that belong to the wind tunnel, not to the car (compared ignoring case).
    private static final String[] SKIPPED = {"floor", "ground", "road", "walls", "wall", "tunnel", "symmetry", "sym", "top", "side"};
    // The team's lambda2 iso value (derived part "Lambda2" in UPSI_CFD_BASE).
    private static final double DEFAULT_VORTEX_ISO = 30000;

    private Simulation simulation;

    @Override
    public void execute() {
        simulation = getActiveSimulation();
        IsoPart temporary = null;
        try {
            File folder = new File(simulation.getSessionDir(), "3D-data");
            folder.mkdirs();
            listFields(new File(folder, "fields.txt"));

            ArrayList<Region> regions = new ArrayList<>();
            for (Region region : simulation.getRegionManager().getRegions()) {
                if (!region.getPresentationName().toLowerCase(Locale.ROOT).startsWith("cells deleted")) {
                    regions.add(region);
                }
            }
            ArrayList<Boundary> surfaces = new ArrayList<>();
            for (Region region : regions) {
                for (Boundary boundary : region.getBoundaryManager().getBoundaries()) {
                    if (boundary.getBoundaryType() instanceof WallBoundary && isCar(boundary.getPresentationName())) {
                        surfaces.add(boundary);
                    }
                }
            }
            ArrayList<FieldFunction> fields = fields(FIELDS, MAGNITUDES, true);
            ArrayList<FieldFunction> flowFields = fields(FLOW_FIELDS, FLOW_MAGNITUDES, false);

            ArrayList<Part> parts = new ArrayList<>();
            if (!"false".equalsIgnoreCase(setting("3D-Data/Vortices"))) {
                Part lambda2 = derivedPart("Lambda2");
                if (lambda2 == null) {
                    lambda2 = temporary = vortexPart(regions);
                }
                if (lambda2 != null) {
                    parts.add(lambda2);
                }
            }
            if (!"false".equalsIgnoreCase(setting("3D-Data/Bad Cells"))) {
                Part badCells = derivedPart("Bad_Cells");
                if (badCells != null) {
                    parts.add(badCells);
                }
            }

            String name = simulation.getPresentationName();
            if (surfaces.isEmpty() || fields.isEmpty()) {
                simulation.println("export3D: no car surfaces or fields (" + surfaces.size() + " surfaces, " + fields.size() + " fields)");
            } else {
                export(new File(folder, name + ".case"), surfaces, new ArrayList<Part>(), fields);
                simulation.println("export3D: " + surfaces.size() + " car surfaces with " + fields.size() + " fields written");
            }
            if (!parts.isEmpty() && !flowFields.isEmpty()) {
                try {
                    export(new File(folder, name + "_flow.case"), new ArrayList<Boundary>(), parts, flowFields);
                    ArrayList<String> partNames = new ArrayList<>();
                    for (Part part : parts) {
                        partNames.add(part.getPresentationName());
                    }
                    simulation.println("export3D: flow parts " + partNames + " with " + flowFields.size() + " fields written");
                } catch (Exception e) {
                    simulation.println("export3D: flow parts failed, the car data is complete: " + e);
                }
            }
        } catch (Exception e) {
            simulation.println("export3D failed, post-processing continues: " + e);
        } finally {
            if (temporary != null) {
                try {
                    simulation.getPartManager().removeObjects(temporary);
                } catch (Exception e) {
                    simulation.println("export3D: could not remove the temporary Lambda2 part: " + e);
                }
            }
        }
    }

    // Boundaries and derived parts only (regions would add the whole volume mesh), values per cell.
    private void export(File caseFile, ArrayList<Boundary> surfaces, ArrayList<Part> parts, ArrayList<FieldFunction> fields) {
        simulation.getImportManager().export(caseFile.getPath(), new ArrayList<Region>(), surfaces, parts,
                new ArrayList<PartSurface>(), fields,
                NeoProperty.fromString("{'exportFormatType': 2, 'appendToFile': false, 'solutionOnly': false, 'dataAtVerts': false}"));
    }

    // Scalars as they are, vectors as their magnitude; missing ones are reported once (report = true).
    private ArrayList<FieldFunction> fields(String[] scalars, String[] vectors, boolean report) {
        ArrayList<FieldFunction> found = new ArrayList<>();
        for (String name : scalars) {
            FieldFunction function = find(name);
            if (function != null) {
                found.add(function);
            } else if (report) {
                simulation.println("export3D: no field function " + name + ", left out");
            }
        }
        for (String name : vectors) {
            FieldFunction function = find(name);
            if (function != null) {
                found.add(function.getMagnitudeFunction());
            } else if (report) {
                simulation.println("export3D: no field function " + name + ", left out");
            }
        }
        return found;
    }

    private Part derivedPart(String name) {
        for (Part part : simulation.getPartManager().getObjects()) {
            if (part.getPresentationName().equalsIgnoreCase(name)) {
                return part;
            }
        }
        return null;
    }

    // Fallback when the simulation has no "Lambda2" part: a temporary iso-surface of neg(Lambda2)
    // (vortex cores positive); a plain lambda2 function gets the negative threshold.
    private IsoPart vortexPart(ArrayList<Region> regions) {
        FieldFunction lambda2 = null;
        for (FieldFunction function : simulation.getFieldFunctionManager().getObjects()) {
            String key = simplified(function.getPresentationName()) + " " + simplified(function.getFunctionName());
            if (key.contains("lambda2") && (lambda2 == null || key.contains("neg"))) {
                lambda2 = function;
            }
        }
        if (lambda2 == null) {
            simulation.println("export3D: no Lambda2 part or lambda2 field function, no vortices");
            return null;
        }
        double iso = DEFAULT_VORTEX_ISO;
        try {
            String value = setting("3D-Data/Vortices Iso Value");
            if (value != null) {
                iso = Math.abs(Double.parseDouble(value));
            }
        } catch (NumberFormatException e) {
            simulation.println("export3D: Vortices Iso Value is not a number, using " + iso);
        }
        boolean negated = (simplified(lambda2.getPresentationName()) + simplified(lambda2.getFunctionName())).contains("neg");
        IsoPart part = simulation.getPartManager().createIsoPart(new Vector<>(regions), lambda2);
        part.setPresentationName("Lambda2");
        part.setMode(IsoMode.ISOVALUE_SINGLE);
        part.getSingleIsoValue().setValue(negated ? iso : -iso);
        simulation.println("export3D: temporary Lambda2 part = " + lambda2.getPresentationName() + " at " + (negated ? iso : -iso));
        return part;
    }

    private FieldFunction find(String name) {
        FieldFunctionManager functions = simulation.getFieldFunctionManager();
        if (functions.hasFunction(name)) {
            return functions.getFunction(name);
        }
        for (FieldFunction function : functions.getObjects()) {
            if (simplified(function.getPresentationName()).equals(simplified(name))
                    || simplified(function.getFunctionName()).equals(simplified(name))) {
                return function;
            }
        }
        return null;
    }

    private void listFields(File file) {
        try (FileWriter out = new FileWriter(file)) {
            out.write("# Field functions of " + simulation.getPresentationName() + ": name | display name | type\n");
            for (FieldFunction function : simulation.getFieldFunctionManager().getObjects()) {
                out.write(function.getFunctionName() + " | " + function.getPresentationName() + " | " + function.getTypeAsEnum() + "\n");
            }
        } catch (Exception e) {
            simulation.println("export3D: could not write " + file + ": " + e);
        }
    }

    // A "Group/Name : value" line of the case's Settings file, or null.
    private String setting(String key) {
        File file = new File(simulation.getSessionDir(), "Settings");
        try (BufferedReader in = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = in.readLine()) != null) {
                String[] parts = line.split(" : ", 2);
                if (parts.length == 2 && parts[0].trim().equals(key)) {
                    return parts[1].trim();
                }
            }
        } catch (IOException e) {
            return null;
        }
        return null;
    }

    private static String simplified(String text) {
        return text == null ? "" : text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    private static boolean isCar(String name) {
        String lower = name.toLowerCase(Locale.ROOT).trim();
        if (lower.startsWith("internal") || lower.contains("interface") || lower.contains("[")) {
            return false;
        }
        for (String skipped : SKIPPED) {
            if (lower.equals(skipped)) {
                return false;
            }
        }
        return true;
    }
}
